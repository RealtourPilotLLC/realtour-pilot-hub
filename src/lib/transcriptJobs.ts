import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";

// ---------------------------------------------------------------------------
// TRANSCRIPT JOBS (spec §20), Sep 16 2026 — the durable queue between a
// confirmed transcript and everything the program makes from it.
//
// One row = one unit of work on one call record, with queued / running /
// succeeded / failed / needs-review states, a lease so a dead lambda cannot
// hold a job forever, attempts + backoff, and a dedupe key so a rerun is the
// SAME row (docs/CONTENT-PROGRAM-SCHEMA.md §4):
//
//   INGEST         <callRecordId>:<transcriptSourceId>:INGEST   (per SOURCE)
//   ANALYZE        <callRecordId>:ANALYZE                        (per CALL)
//   STRATEGY_DRAFT <callRecordId>:STRATEGY_DRAFT
//   SCRIPT_DRAFT   <callRecordId>:SCRIPT_DRAFT
//   FACT_EXTRACT   <callRecordId>:FACT_EXTRACT
//
// WHO DOES WHAT. This module owns the queue and the INGEST handler (pulling
// the words of one source copy). The AI kinds are W1-C's: contentPipeline.ts
// exports `transcriptJobHandlers` (see TranscriptJobHandler below) and this
// driver looks it up at run time. A kind with no handler in the build STAYS
// QUEUED with lastError saying so — never FAILED, never silently dropped —
// and the monitoring snapshot names it.
//
// THE SWITCH. driveTranscriptJobs runs only when the `transcript_jobs`
// automation is enabled (programAutomation.ts: a missing row is OFF). With
// the switch off, rows can be ENQUEUED (so nothing is lost) but nothing runs.
// ---------------------------------------------------------------------------

export const TRANSCRIPT_JOB_KINDS = ["INGEST", "ANALYZE", "STRATEGY_DRAFT", "SCRIPT_DRAFT", "FACT_EXTRACT"] as const;
export type TranscriptJobKind = (typeof TRANSCRIPT_JOB_KINDS)[number];
export const isTranscriptJobKind = (k: unknown): k is TranscriptJobKind => typeof k === "string" && (TRANSCRIPT_JOB_KINDS as readonly string[]).includes(k);

export type TranscriptJobState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "NEEDS_REVIEW" | "CANCELLED";

/** The dedupe key for a kind — the ONLY place the format lives. */
export function transcriptJobDedupeKey(kind: TranscriptJobKind, callRecordId: string, transcriptSourceId?: string | null): string {
  if (kind === "INGEST") {
    if (!transcriptSourceId) throw new Error("INGEST jobs are keyed per transcript source.");
    return `${callRecordId}:${transcriptSourceId}:INGEST`;
  }
  return `${callRecordId}:${kind}`;
}

export type TranscriptJobRow = {
  id: string;
  callRecordId: string;
  transcriptSourceId: string | null;
  enrollmentId: string | null;
  kind: TranscriptJobKind;
  attempts: number;
  maxAttempts: number;
  requestedBy: string | null;
};

/** What a handler returns. `produced` lands in resultJson; `needsReview` parks the job for a human. */
export type TranscriptJobOutcome =
  | { ok: true; produced?: Record<string, unknown>; aiRunId?: string | null }
  | { ok: false; needsReview: string; produced?: Record<string, unknown> }
  /** The work did not happen because an owner switch is off. NOT a failure:
   *  the job goes back on the queue with its attempt given back, so the moment
   *  the switch returns it runs. See the sweep's `paused` branch. */
  | { ok: false; paused: string }
  /** THIS job cannot run yet, for a reason of its own — its call's client is
   *  in question, or the analysis it must follow has not finished (A04/A09,
   *  Sep 25 2026). Re-queued with the attempt given back and a later
   *  nextAttemptAt, and the sweep MOVES ON: `paused` stops the whole tick
   *  (right for a global switch), and a per-job wait that did that would sit
   *  at the head of the oldest-first queue and starve every other call. */
  | { ok: false; waiting: string; retryInMs?: number }
  | { ok: false; error: string; retryable?: boolean };

export type TranscriptJobContext = {
  leaseBy: string;
  /** Refresh the lease from a long handler (every few minutes on a 10-minute lease). */
  heartbeat: () => Promise<void>;
};
export type TranscriptJobHandler = (job: TranscriptJobRow, ctx: TranscriptJobContext) => Promise<TranscriptJobOutcome>;
export type TranscriptJobHandlers = Partial<Record<TranscriptJobKind, TranscriptJobHandler>>;

const LEASE_MS = 10 * 60_000;
// Backoff by attempt: 5 min, 30 min, 2 h. Past maxAttempts → NEEDS_REVIEW.
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 120 * 60_000];

/**
 * Enqueue (or re-arm) one job. Idempotent on the dedupe key: a SUCCEEDED row
 * is returned untouched unless `rerun` is asked for (a corrected transcript, a
 * human's "re-analyze"); a FAILED / CANCELLED / NEEDS_REVIEW row is re-queued
 * with its attempt history kept.
 */
export async function enqueueTranscriptJob(input: {
  callRecordId: string;
  kind: TranscriptJobKind;
  transcriptSourceId?: string | null;
  enrollmentId?: string | null;
  requestedBy?: string | null;
  rerun?: boolean;
  maxAttempts?: number;
}): Promise<{ id: string; state: string; created: boolean }> {
  const dedupeKey = transcriptJobDedupeKey(input.kind, input.callRecordId, input.transcriptSourceId);
  const existing = await prisma.programTranscriptJob.findUnique({ where: { dedupeKey }, select: { id: true, state: true } });
  if (existing) {
    const reArm = existing.state === "FAILED" || existing.state === "CANCELLED" || existing.state === "NEEDS_REVIEW" || (input.rerun && existing.state === "SUCCEEDED");
    if (!reArm) return { id: existing.id, state: existing.state, created: false };
    const row = await prisma.programTranscriptJob.update({
      where: { id: existing.id },
      data: { state: "QUEUED", nextAttemptAt: null, leaseUntil: null, leaseBy: null, finishedAt: null, reviewReason: null, lastError: null, lastErrorAt: null, requestedBy: input.requestedBy ?? undefined },
      select: { id: true, state: true },
    });
    return { ...row, created: false };
  }
  const row = await prisma.programTranscriptJob.create({
    data: {
      callRecordId: input.callRecordId,
      transcriptSourceId: input.transcriptSourceId ?? null,
      enrollmentId: input.enrollmentId ?? null,
      kind: input.kind,
      dedupeKey,
      requestedBy: input.requestedBy ?? null,
      ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    },
    select: { id: true, state: true },
  });
  return { ...row, created: true };
}

/** Cancel every open job on a call record (its transcript was rejected, the booking cancelled). */
export async function cancelTranscriptJobs(callRecordId: string, reason: string): Promise<number> {
  const r = await prisma.programTranscriptJob.updateMany({
    where: { callRecordId, state: { in: ["QUEUED", "NEEDS_REVIEW", "FAILED"] } },
    data: { state: "CANCELLED", lastError: reason.slice(0, 500), lastErrorAt: new Date(), finishedAt: new Date() },
  });
  return r.count;
}

// ---------------------------------------------------------------------------
// The INGEST handler — ours. A source row already holds the exported text
// when the sweep confirmed it; INGEST makes that durable: re-export when the
// text is missing, refuse a stub, and stamp the call record's transcript
// state. It never analyses anything.
// ---------------------------------------------------------------------------
async function ingestHandler(job: TranscriptJobRow): Promise<TranscriptJobOutcome> {
  if (!job.transcriptSourceId) return { ok: false, needsReview: "INGEST job has no transcript source" };
  const src = await prisma.programTranscriptSource.findUnique({
    where: { id: job.transcriptSourceId },
    select: { id: true, provider: true, externalId: true, text: true, matchState: true, callRecordId: true },
  });
  if (!src) return { ok: false, needsReview: "transcript source row is gone" };
  if (src.matchState !== "CONFIRMED" || src.callRecordId !== job.callRecordId) {
    return { ok: false, needsReview: `source is ${src.matchState}, not confirmed for this call` };
  }
  let text = src.text;
  if (!text && src.provider === "drive" && src.externalId) {
    const { readTranscript } = await import("@/lib/integrations/googleDrive");
    text = (await readTranscript(src.externalId)).trim().slice(0, 500_000);
    await prisma.programTranscriptSource.update({ where: { id: src.id }, data: { text } });
  }
  if (!text || text.length < 200) return { ok: false, needsReview: "transcript is empty or a stub (< 200 chars) — paste or upload the real one" };
  await prisma.programCallRecord.updateMany({
    where: { id: job.callRecordId, transcriptState: { in: ["NONE", "AWAITING", "CANDIDATES", "CONFIRMED", "FAILED"] } },
    data: { transcriptState: "CONFIRMED", lastError: null, lastErrorAt: null },
  });
  return { ok: true, produced: { transcriptSourceId: src.id, chars: text.length } };
}

/** Handlers available in THIS build: ours plus whatever W1-C exports. */
export async function availableHandlers(): Promise<TranscriptJobHandlers> {
  const handlers: TranscriptJobHandlers = { INGEST: ingestHandler };
  try {
    // Looked up dynamically and typed loosely on purpose: this file must not
    // break the build when C's export does not exist yet.
    const mod = (await import("@/lib/contentPipeline")) as unknown as { transcriptJobHandlers?: TranscriptJobHandlers };
    const theirs = mod.transcriptJobHandlers;
    if (theirs && typeof theirs === "object") {
      for (const k of TRANSCRIPT_JOB_KINDS) {
        if (k !== "INGEST" && typeof theirs[k] === "function") handlers[k] = theirs[k];
      }
    }
  } catch { /* the pipeline module failing to load is reported per job below */ }
  return handlers;
}

// ---------------------------------------------------------------------------
// The driver.
// ---------------------------------------------------------------------------
export async function driveTranscriptJobs(opts: { max?: number; budgetMs?: number; leaseBy?: string; now?: Date } = {}): Promise<
  { skipped: string } | { ran: number; succeeded: number; failed: number; needsReview: number; paused: string | null; waitingForHandler: number; recovered: number; waiting: number }
> {
  if (!(await isAutomationEnabled("transcript_jobs"))) return { skipped: "transcript_jobs is off" };
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budget = opts.budgetMs ?? 60_000;
  const leaseBy = opts.leaseBy ?? "transcriptJobs";
  const max = opts.max ?? 5;
  const handlers = await availableHandlers();

  // Recover work a dead run left RUNNING with an expired lease. A job that
  // has already used every attempt hanging past its lease is not re-queued
  // (it would cycle RUNNING→QUEUED forever) — it goes to a person.
  let recovered = 0;
  const expired = await prisma.programTranscriptJob.findMany({
    where: { state: "RUNNING", leaseUntil: { lt: now } },
    select: { id: true, attempts: true, maxAttempts: true, callRecordId: true, kind: true },
  });
  for (const j of expired) {
    const exhausted = j.attempts >= j.maxAttempts;
    await prisma.programTranscriptJob.update({
      where: { id: j.id },
      data: exhausted
        ? { state: "NEEDS_REVIEW", leaseUntil: null, leaseBy: null, finishedAt: now, lastError: "lease expired", lastErrorAt: now, reviewReason: `lease expired ${j.attempts}× — the handler never finished` }
        : { state: "QUEUED", leaseUntil: null, leaseBy: null, lastError: "lease expired — re-queued", lastErrorAt: now },
    });
    if (exhausted && j.kind === "INGEST") {
      await prisma.programCallRecord.update({ where: { id: j.callRecordId }, data: { transcriptState: "NEEDS_REVIEW", lastError: `${j.kind}: lease expired ${j.attempts}×`.slice(0, 1000), lastErrorAt: now } }).catch(() => {});
    }
    recovered++;
  }

  // Kinds with no handler in this build are marked ONCE (so the snapshot and
  // the panel say why they wait) and then left out of the candidate query:
  // they never consume a slot of `max`, so five ANALYZE jobs waiting for W1-C's
  // export cannot starve a fresh INGEST behind them.
  const runnable = TRANSCRIPT_JOB_KINDS.filter((k) => typeof handlers[k] === "function");
  const unrunnable = TRANSCRIPT_JOB_KINDS.filter((k) => !runnable.includes(k));
  let waitingForHandler = 0;
  for (const k of unrunnable) {
    const r = await prisma.programTranscriptJob.updateMany({
      where: { state: "QUEUED", kind: k, OR: [{ lastError: null }, { lastError: { not: { startsWith: `no ${k} handler` } } }] },
      data: { lastError: `no ${k} handler in this build (contentPipeline.transcriptJobHandlers) — job waits`, lastErrorAt: now },
    });
    waitingForHandler += r.count;
  }

  let ran = 0, succeeded = 0, failed = 0, needsReview = 0, waiting = 0;
  let lastError: string | null = null;
  let paused: string | null = null;
  while (ran < max && Date.now() - started < budget && runnable.length > 0) {
    // Oldest first, INGEST before the kinds that depend on it.
    const candidate = await prisma.programTranscriptJob.findFirst({
      where: { state: "QUEUED", kind: { in: runnable }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: [{ createdAt: "asc" }],
      select: { id: true, kind: true, callRecordId: true, transcriptSourceId: true, enrollmentId: true, attempts: true, maxAttempts: true, requestedBy: true },
    });
    if (!candidate || !isTranscriptJobKind(candidate.kind)) break;
    const kind = candidate.kind;
    const handler = handlers[kind];
    if (!handler) break; // cannot happen (kind ∈ runnable); keeps the type narrow
    // ATOMIC CLAIM: whoever flips QUEUED→RUNNING owns the lease.
    const claim = await prisma.programTranscriptJob.updateMany({
      where: { id: candidate.id, state: "QUEUED" },
      data: { state: "RUNNING", leaseBy, leaseUntil: new Date(Date.now() + LEASE_MS), attempts: { increment: 1 }, startedAt: now, nextAttemptAt: null },
    });
    if (claim.count === 0) continue; // another runner took it
    ran++;
    const job: TranscriptJobRow = { ...candidate, kind, attempts: candidate.attempts + 1 };
    const heartbeat = async () => {
      await prisma.programTranscriptJob.updateMany({ where: { id: job.id, leaseBy }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {});
    };
    let outcome: TranscriptJobOutcome;
    try {
      outcome = await handler(job, { leaseBy, heartbeat });
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e), retryable: true };
    }
    const finishedAt = new Date();
    if (outcome.ok) {
      await prisma.programTranscriptJob.update({
        where: { id: job.id },
        data: { state: "SUCCEEDED", finishedAt, leaseUntil: null, leaseBy: null, lastError: null, lastErrorAt: null, resultJson: outcome.produced ? JSON.stringify(outcome.produced) : null, aiRunId: outcome.aiRunId ?? undefined },
      });
      succeeded++;
    } else if ("paused" in outcome) {
      // Give the attempt back. The claim incremented it, and an attempt that
      // was refused by a switch is not an attempt the job used up — without
      // this, three hourly ticks with `ai_runs` off exhaust maxAttempts and
      // park the job in NEEDS_REVIEW permanently.
      await prisma.programTranscriptJob.update({
        where: { id: job.id },
        data: { state: "QUEUED", leaseUntil: null, leaseBy: null, startedAt: null, attempts: { decrement: 1 }, nextAttemptAt: null, lastError: null, lastErrorAt: null },
      });
      paused = outcome.paused.slice(0, 300);
      ran--;
      break; // the switch is global — every remaining job would refuse the same way
    } else if ("waiting" in outcome) {
      // A per-job wait: the attempt is given back, the reason is on the row
      // (the panel shows it), and it is not picked again THIS tick — the
      // retry lands after the later of the tick's clock and the real one.
      const base = Math.max(Date.now(), now.getTime());
      await prisma.programTranscriptJob.update({
        where: { id: job.id },
        data: { state: "QUEUED", leaseUntil: null, leaseBy: null, startedAt: null, attempts: { decrement: 1 }, nextAttemptAt: new Date(base + (outcome.retryInMs ?? 5 * 60_000)), lastError: `waiting: ${outcome.waiting}`.slice(0, 1000), lastErrorAt: finishedAt },
      });
      waiting++;
      ran--;
    } else if ("needsReview" in outcome) {
      await prisma.programTranscriptJob.update({
        where: { id: job.id },
        data: { state: "NEEDS_REVIEW", finishedAt, leaseUntil: null, leaseBy: null, reviewReason: outcome.needsReview.slice(0, 1000), resultJson: outcome.produced ? JSON.stringify(outcome.produced) : undefined },
      });
      await prisma.programCallRecord.update({ where: { id: job.callRecordId }, data: { transcriptState: "NEEDS_REVIEW", lastError: `${kind}: ${outcome.needsReview}`.slice(0, 1000), lastErrorAt: finishedAt } }).catch(() => {});
      needsReview++;
    } else {
      const exhausted = job.attempts >= job.maxAttempts || outcome.retryable === false;
      const backoff = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      await prisma.programTranscriptJob.update({
        where: { id: job.id },
        data: exhausted
          ? { state: "NEEDS_REVIEW", finishedAt, leaseUntil: null, leaseBy: null, lastError: outcome.error.slice(0, 1000), lastErrorAt: finishedAt, reviewReason: `failed ${job.attempts}× — last: ${outcome.error}`.slice(0, 1000) }
          : { state: "QUEUED", leaseUntil: null, leaseBy: null, lastError: outcome.error.slice(0, 1000), lastErrorAt: finishedAt, nextAttemptAt: new Date(Date.now() + backoff) },
      });
      // The record's transcriptState is about the TRANSCRIPT: only an INGEST
      // failure changes it. An AI hiccup on ANALYZE leaves a confirmed
      // transcript confirmed — the job row (and lastError) carry the failure.
      await prisma.programCallRecord.update({
        where: { id: job.callRecordId },
        data: { ...(kind === "INGEST" ? { transcriptState: exhausted ? "NEEDS_REVIEW" : "FAILED" } : {}), lastError: `${kind}: ${outcome.error}`.slice(0, 1000), lastErrorAt: finishedAt },
      }).catch(() => {});
      failed++;
      lastError = outcome.error;
    }
  }
  // `paused` is not passed: a stop the owner asked for is not a failed run, and
  // programMonitoring turns a stamped lastError into an hourly alert.
  await recordAutomationRun("transcript_jobs", lastError);
  return { ran, succeeded, failed, needsReview, paused, waitingForHandler, recovered, waiting };
}

/** For the monitoring view: counts per state × kind, plus which kinds have a handler in this build. */
export async function transcriptJobsSnapshot(): Promise<{
  enabled: boolean;
  handlers: Record<TranscriptJobKind, boolean>;
  counts: { kind: string; state: string; n: number }[];
  oldestQueuedAt: Date | null;
  recent: { id: string; kind: string; state: string; callRecordId: string; attempts: number; lastError: string | null; reviewReason: string | null; updatedAt: Date }[];
}> {
  const [enabled, handlers, grouped, oldest, recent] = await Promise.all([
    isAutomationEnabled("transcript_jobs"),
    availableHandlers(),
    prisma.programTranscriptJob.groupBy({ by: ["kind", "state"], _count: { _all: true } }),
    prisma.programTranscriptJob.findFirst({ where: { state: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.programTranscriptJob.findMany({
      orderBy: { updatedAt: "desc" }, take: 25,
      select: { id: true, kind: true, state: true, callRecordId: true, attempts: true, lastError: true, reviewReason: true, updatedAt: true },
    }),
  ]);
  const h = Object.fromEntries(TRANSCRIPT_JOB_KINDS.map((k) => [k, typeof handlers[k] === "function"])) as Record<TranscriptJobKind, boolean>;
  return {
    enabled, handlers: h,
    counts: grouped.map((g) => ({ kind: g.kind, state: g.state, n: g._count._all })),
    oldestQueuedAt: oldest?.createdAt ?? null,
    recent,
  };
}
