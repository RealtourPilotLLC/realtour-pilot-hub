import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun, type AutomationKey } from "@/lib/programAutomation";
import { CLOSED_ROLLOUT, clientTier, type ProgramRollout } from "@/lib/programRolloutCore";
import { etMonthDay } from "@/lib/datetime";

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
//
// WHAT THE SWITCH ALONE DID NOT SAY (R05, Sep 28 2026). INGEST and ANALYZE
// are enqueued with no switch at all — only an enabled Calendly mapping — so
// a backlog of real clients' calls can build up while every AI switch is off,
// and turning the processor on would have worked through all of it, oldest
// first, spending AI credit on calls nobody had asked about. And the queue
// ran a STRATEGY_DRAFT whatever `strategy_generation` said. Three holds now
// sit in front of the candidate query, each decided per job by ONE function
// (holdReasonFor) that the driver and the read-only batch below both use, so
// what Settings says is waiting is exactly what the driver will skip:
//   1. the kind's own switch (KIND_OWNER): a STRATEGY_DRAFT waits while
//      strategy_generation is off, a SCRIPT_DRAFT while script_drafting is —
//      so turning one off stops the drafts already queued, not only new ones;
//   2. the backlog cutoff (business default, Sep 28): the processor takes
//      ONLY jobs queued after it was first switched on. The moment is pinned
//      in its config (`onlyQueuedAfter`) the first time it runs; the owner can
//      choose to include the older ones ("ALL") in Settings → Calendly &
//      calls, which shows how many that is before he does;
//   3. the rollout (business default, Sep 28): until the rollout is set to
//      every client, internal AI work (every kind but INGEST, which only pulls
//      the words in) runs only for TEST clients and the named pilot clients
//      (programRolloutCore.clientTier). An unreadable rollout is TEST only.
// A held job is marked once ("waiting: …" on lastError, the house wording for
// a job that cannot run yet), is never claimed, and keeps its attempts — it
// runs the tick after its hold lifts. Like the handler-less kinds, a held job
// never takes a slot of `max`, so a held head cannot starve the queue.
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

/** Jobs per hourly run: the route's own bound (cron/sync driveTranscriptJobs max 5). */
export const TRANSCRIPT_JOBS_PER_TICK = 5;

/**
 * The switch that owns each kind's WORK, on top of transcript_jobs (R05, Sep
 * 28 2026). While it is off the kind waits in the queue, attempt untouched.
 * FACT_EXTRACT has no owner: fact_extraction decides auto-ACCEPTANCE, not
 * whether facts are extracted.
 */
export const KIND_OWNER: Partial<Record<TranscriptJobKind, AutomationKey>> = {
  STRATEGY_DRAFT: "strategy_generation",
  SCRIPT_DRAFT: "script_drafting",
};

/** The transcript_jobs config field that holds the backlog cutoff. */
export const BACKLOG_FIELD = "onlyQueuedAfter";
/** The owner's "include the jobs queued before" choice, stored in BACKLOG_FIELD. */
export const INCLUDE_BACKLOG = "ALL";
/**
 * The FIRST switch-on, kept in its own field and written once (review fix,
 * Sep 28 2026). BACKLOG_FIELD is overwritten by the owner's "include" (ALL)
 * and cleared by "skip"; with only that field, "skip" fell back to the
 * switch's enabledAt, which setAutomationEnabled resets on EVERY turn-on — so
 * after an off/on cycle "skip" re-pinned to the LATEST switch-on and quietly
 * skipped jobs queued in between, the opposite of what the pin promises.
 * "skip" now restores this moment, and the cutoff falls back to it.
 */
export const FIRST_ON_FIELD = "firstSwitchedOnAt";

export type BacklogCutoff = {
  /** Jobs created before this are skipped. null = none are (the owner included them, or nothing is on yet). */
  cutoff: Date | null;
  /** The first switch-on on record (FIRST_ON_FIELD), whatever the owner chose since; null before the first run records it. */
  firstSwitchedOnAt?: Date | null;
  /**
   *   pinned       the stored moment (written the first time the processor ran, or by the owner)
   *   switch_on    not pinned yet: the moment the switch was last turned on
   *   include_all  the owner chose to include every job queued before
   *   never_on     the switch has never been turned on: every job waiting NOW will be skipped when it is
   */
  source: "pinned" | "switch_on" | "include_all" | "never_on";
};

/**
 * Where the backlog starts, from the switch's stored config and its enabledAt.
 * Pure. For "never_on" the cutoff is `now`: every job already waiting is one
 * the first switch-on will skip, which is what Settings must say BEFORE it.
 */
export function backlogCutoff(cfg: Record<string, unknown> | null, enabledAt: Date | null, now: Date): BacklogCutoff {
  const v = cfg?.[BACKLOG_FIELD];
  const f = cfg?.[FIRST_ON_FIELD];
  const firstSwitchedOnAt = typeof f === "string" && Number.isFinite(Date.parse(f)) ? new Date(f) : null;
  if (v === INCLUDE_BACKLOG) return { cutoff: null, source: "include_all", firstSwitchedOnAt };
  if (typeof v === "string" && Number.isFinite(Date.parse(v))) return { cutoff: new Date(v), source: "pinned", firstSwitchedOnAt };
  // Cleared ("skip") after the first run recorded it: back to the FIRST switch-on.
  if (firstSwitchedOnAt) return { cutoff: firstSwitchedOnAt, source: "pinned", firstSwitchedOnAt };
  if (enabledAt) return { cutoff: enabledAt, source: "switch_on", firstSwitchedOnAt };
  return { cutoff: now, source: "never_on", firstSwitchedOnAt };
}

/** The switch's stored config and switch-on moment, whether it is on or off. Never throws: unreadable → no config. */
async function processorState(): Promise<{ enabled: boolean; enabledAt: Date | null; cfg: Record<string, unknown> | null; unreadable: boolean }> {
  const row = await prisma.programAutomation.findUnique({ where: { key: "transcript_jobs" }, select: { enabled: true, enabledAt: true, configJson: true } });
  let cfg: Record<string, unknown> | null = null;
  let unreadable = false;
  if (row?.configJson) {
    try {
      const v: unknown = JSON.parse(row.configJson);
      if (v && typeof v === "object" && !Array.isArray(v)) cfg = v as Record<string, unknown>;
      else unreadable = true;
    } catch {
      unreadable = true;
    }
  }
  return { enabled: row?.enabled === true, enabledAt: row?.enabledAt ?? null, cfg, unreadable };
}

/** The rollout for the internal-AI hold. A read failure is TEST only (fail closed). */
async function rolloutForProcessor(): Promise<{ rollout: ProgramRollout; problem: string | null }> {
  try {
    const { loadProgramRollout } = await import("@/lib/programRollout");
    const r = await loadProgramRollout();
    return { rollout: r.rollout, problem: r.problem };
  } catch (e) {
    return { rollout: { ...CLOSED_ROLLOUT }, problem: `the rollout could not be read (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)})` };
  }
}

type QueuedJob = { id: string; kind: string; createdAt: Date; attempts: number; nextAttemptAt: Date | null; callRecordId: string; enrollmentId: string | null; requestedBy: string | null; lastError: string | null };
type JobClient = { id: string; name: string } | null;

/** The client each job concerns: the call's matched client, else the job's enrollment's. One read each. */
async function clientsForJobs(jobs: { callRecordId: string; enrollmentId: string | null }[]): Promise<Map<string, JobClient>> {
  const callIds = [...new Set(jobs.map((j) => j.callRecordId))];
  const calls = callIds.length ? await prisma.programCallRecord.findMany({ where: { id: { in: callIds } }, select: { id: true, clientId: true, enrollmentId: true } }) : [];
  const enrollIds = [...new Set([...jobs.map((j) => j.enrollmentId), ...calls.map((c) => c.enrollmentId)].filter((x): x is string => !!x))];
  const enrollments = enrollIds.length ? await prisma.contentEnrollment.findMany({ where: { id: { in: enrollIds } }, select: { id: true, clientId: true } }) : [];
  const enrollClient = new Map(enrollments.map((e) => [e.id, e.clientId]));
  const callClient = new Map(calls.map((c) => [c.id, c.clientId ?? (c.enrollmentId ? enrollClient.get(c.enrollmentId) ?? null : null)]));
  const clientIds = [...new Set([...callClient.values(), ...enrollClient.values()].filter((x): x is string => !!x))];
  const clients = clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const out = new Map<string, JobClient>();
  for (const j of jobs) {
    const cid = callClient.get(j.callRecordId) ?? (j.enrollmentId ? enrollClient.get(j.enrollmentId) ?? null : null);
    out.set(`${j.callRecordId}|${j.enrollmentId ?? ""}`, cid ? byId.get(cid) ?? null : null);
  }
  return out;
}
const clientKey = (j: { callRecordId: string; enrollmentId: string | null }) => `${j.callRecordId}|${j.enrollmentId ?? ""}`;

export type HoldContext = {
  runnableKinds: readonly string[];
  ownerOn: Partial<Record<AutomationKey, boolean>>;
  backlog: BacklogCutoff;
  rollout: ProgramRollout;
  now: Date;
};
export type HoldKind = "handler" | "owner" | "backlog" | "scope";

/**
 * Is this lastError one of holdReasonFor's marks (the words the driver writes
 * on a job it holds)? A job still carrying one while nothing holds it any more
 * had its hold lifted AFTER the last tick classified it (review fix, Sep 28
 * 2026 — see transcriptQueueBatch's "runnable since"). Kept beside
 * holdReasonFor, whose sentences it must match. A handler's own per-job
 * "waiting: …" (callAndTranscript) is not a mark: it carries its own retry time.
 */
export function isHoldMark(lastError: string | null | undefined): boolean {
  const e = lastError ?? "";
  return /^no [A-Z_]+ handler in this build/.test(e)
    || /^waiting: [a-z_]+ is off$/.test(e)
    || (e.startsWith("waiting: queued ") && e.includes("before the call processor was first switched on"))
    || (e.startsWith("waiting: ") && e.includes(" is outside the rollout — internal AI work runs only"));
}

/**
 * Why this QUEUED job may not run now, or null. THE one rule — the driver
 * skips exactly what this names, and transcriptQueueBatch counts exactly the
 * same. Order: no handler, the kind's own switch, the backlog, the rollout.
 * A job whose client is not known yet is not held here: the handler itself
 * waits on the call's identity (contentGeneration.callAndTranscript).
 */
export function holdReasonFor(job: { kind: string; createdAt: Date; attempts: number }, client: JobClient, ctx: HoldContext): { kind: HoldKind; reason: string } | null {
  if (!ctx.runnableKinds.includes(job.kind)) return { kind: "handler", reason: `no ${job.kind} handler in this build (contentPipeline.transcriptJobHandlers) — job waits` };
  const owner = KIND_OWNER[job.kind as TranscriptJobKind];
  if (owner && ctx.ownerOn[owner] !== true) return { kind: "owner", reason: `waiting: ${owner} is off` };
  // A job that has been ATTEMPTED already ran after the processor was on, so
  // it is not backlog, whatever its createdAt: a re-armed row (the owner's
  // Re-run, a corrected transcript) keeps the date it was first queued.
  if (ctx.backlog.cutoff && job.attempts === 0 && job.createdAt.getTime() < ctx.backlog.cutoff.getTime()) {
    return { kind: "backlog", reason: `waiting: queued ${etMonthDay(job.createdAt)}, before the call processor was first switched on — include older jobs in Settings → Calendly & calls to run it` };
  }
  if (job.kind !== "INGEST" && client && ctx.rollout.mode !== "ALL" && clientTier(ctx.rollout, client, ctx.now) === "REAL") {
    return { kind: "scope", reason: `waiting: ${client.name} is outside the rollout — internal AI work runs only for TEST and pilot clients until the rollout reaches every client` };
  }
  return null;
}

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
  | { skipped: string }
  | { ran: number; succeeded: number; failed: number; needsReview: number; paused: string | null; waitingForHandler: number; recovered: number; waiting: number; held: { owner: number; backlog: number; scope: number } }
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

  // THE HOLDS (R05, Sep 28 2026 — see the header). Classified ONCE per tick,
  // before the loop, and the loop claims only jobs classified free: a job
  // enqueued while this tick runs waits for the next tick's classification
  // rather than slipping past the rollout unread.
  const proc = await processorState();
  let backlog = backlogCutoff(proc.unreadable ? null : proc.cfg, proc.enabledAt, now);
  if (backlog.source === "switch_on" && backlog.cutoff && !proc.unreadable) {
    // Pin "first switched on": turning the processor off and on again later
    // must not quietly skip the calls queued while it was off. Audited, one
    // field, under the config's own advisory lock; if it cannot be written
    // this tick still uses the switch-on moment and the next tick tries again.
    try {
      const { setAutomationConfigField } = await import("@/lib/programAutomation");
      await setAutomationConfigField("transcript_jobs", BACKLOG_FIELD, backlog.cutoff.toISOString(), `call processor (${leaseBy})`, "transcript_backlog_pinned");
      backlog = { cutoff: backlog.cutoff, source: "pinned", firstSwitchedOnAt: backlog.firstSwitchedOnAt ?? null };
    } catch { /* see above */ }
  }
  // Record the FIRST switch-on once, in its own field (FIRST_ON_FIELD): the
  // pinned cutoff if there is one, else this switch-on. "skip" restores it.
  if (!backlog.firstSwitchedOnAt && !proc.unreadable) {
    const first = backlog.source === "pinned" && backlog.cutoff ? backlog.cutoff : proc.enabledAt;
    if (first) {
      try {
        const { setAutomationConfigField } = await import("@/lib/programAutomation");
        await setAutomationConfigField("transcript_jobs", FIRST_ON_FIELD, first.toISOString(), `call processor (${leaseBy})`, "transcript_first_switch_on");
        backlog = { ...backlog, firstSwitchedOnAt: first };
      } catch { /* the next tick tries again */ }
    }
  }
  const owners = [...new Set(Object.values(KIND_OWNER))] as AutomationKey[];
  const ownerOn = Object.fromEntries(await Promise.all(owners.map(async (k) => [k, await isAutomationEnabled(k)] as const))) as Partial<Record<AutomationKey, boolean>>;
  const { rollout } = await rolloutForProcessor();
  const queued: QueuedJob[] = await prisma.programTranscriptJob.findMany({
    where: { state: "QUEUED", kind: { in: runnable } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, createdAt: true, attempts: true, nextAttemptAt: true, callRecordId: true, enrollmentId: true, requestedBy: true, lastError: true },
  });
  const jobClients = await clientsForJobs(queued);
  const ctx: HoldContext = { runnableKinds: runnable, ownerOn, backlog, rollout, now };
  const free: string[] = [];
  const held = { owner: 0, backlog: 0, scope: 0 };
  const marks = new Map<string, string[]>();
  for (const j of queued) {
    const h = holdReasonFor(j, jobClients.get(clientKey(j)) ?? null, ctx);
    if (!h) { free.push(j.id); continue; }
    if (h.kind !== "handler") held[h.kind]++;
    if (j.lastError !== h.reason) marks.set(h.reason, [...(marks.get(h.reason) ?? []), j.id]);
  }
  for (const [reason, ids] of marks) {
    // Marked once: a row already carrying this reason is not rewritten each
    // hour. In slices, so a long backlog never meets the bind-parameter limit.
    for (let i = 0; i < ids.length; i += 500) {
      await prisma.programTranscriptJob.updateMany({ where: { id: { in: ids.slice(i, i + 500) }, state: "QUEUED" }, data: { lastError: reason.slice(0, 1000), lastErrorAt: now } });
    }
  }
  // A HOLD THAT LIFTED (review fix, Sep 28 2026). A free, due job still
  // carrying a hold mark became free since the last tick (its owner switch
  // came on, the owner included the backlog, its client joined the pilot).
  // The mark is cleared and nextAttemptAt stamped with THIS tick — "runnable
  // since" for readiness is now the moment a tick first saw it free, not when
  // it was queued: readiness called the queue "not draining" the instant a
  // two-day-old held draft was released, and kept saying so for a whole
  // included backlog.
  const freeSet = new Set(free);
  const freed = queued.filter((j) => freeSet.has(j.id) && isHoldMark(j.lastError) && (!j.nextAttemptAt || j.nextAttemptAt.getTime() <= now.getTime())).map((j) => j.id);
  for (let i = 0; i < freed.length; i += 500) {
    await prisma.programTranscriptJob.updateMany({ where: { id: { in: freed.slice(i, i + 500) }, state: "QUEUED" }, data: { lastError: null, lastErrorAt: null, nextAttemptAt: now } });
  }
  // Oldest first already; a tick claims at most `max`, so the oldest few
  // hundred free ids are all the candidate query ever needs.
  free.splice(500);

  let ran = 0, succeeded = 0, failed = 0, needsReview = 0, waiting = 0;
  let lastError: string | null = null;
  let paused: string | null = null;
  while (ran < max && Date.now() - started < budget && runnable.length > 0 && free.length > 0) {
    // Oldest first, INGEST before the kinds that depend on it.
    const candidate = await prisma.programTranscriptJob.findFirst({
      where: { id: { in: free }, state: "QUEUED", kind: { in: runnable }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
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
    // Retain the error we are recovering from. Another job on this call may
    // fail while this handler runs; success must not erase that newer signal.
    const callError = await prisma.programCallRecord.findUnique({
      where: { id: job.callRecordId }, select: { lastError: true, lastErrorAt: true },
    });
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
      if (callError?.lastError?.startsWith(`${kind}:`)) {
        await prisma.programCallRecord.updateMany({
          where: { id: job.callRecordId, lastError: callError.lastError, lastErrorAt: callError.lastErrorAt },
          data: { lastError: null, lastErrorAt: null },
        });
      }
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
  // PASSED OVER, NOT NEGLECTED (review fix, Sep 28 2026). When this tick had
  // no spare capacity (it took `max`, ran out of budget, or a switch paused
  // it), every free, due job it did not reach is stamped with this tick: it
  // waited its turn behind older work. Readiness's "queue not draining" then
  // means what it says — no tick with room to spare has passed the job by —
  // instead of firing halfway through the drain of an included backlog.
  if (ran >= max || Date.now() - started >= budget || paused) {
    const waitingTurn = free.slice(0, 500);
    if (waitingTurn.length) {
      await prisma.programTranscriptJob.updateMany({
        where: { id: { in: waitingTurn }, state: "QUEUED", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        data: { nextAttemptAt: now },
      });
    }
  }
  // `paused` is not passed: a stop the owner asked for is not a failed run, and
  // programMonitoring turns a stamped lastError into an hourly alert.
  await recordAutomationRun("transcript_jobs", lastError);
  return { ran, succeeded, failed, needsReview, paused, waitingForHandler, recovered, waiting, held };
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

// ---------------------------------------------------------------------------
// WHAT IS QUEUED NOW (R05, Sep 28 2026) — read-only. The batch the processor
// would face the moment it is (or next) switched on, decided by the SAME
// holdReasonFor the driver uses, so "runnable now" here is exactly what the
// next hourly run may claim (up to five of them). Shown on the transcript_jobs
// readiness row, in the confirm before the owner turns the processor on, and
// beside the job lane on Settings → Calendly & calls.
//
// Nothing here writes: no pin, no mark, no claim. A never-switched-on
// processor is judged as if switched on NOW (every job waiting is backlog),
// which is what its first run will actually do unless the owner includes them.
// ---------------------------------------------------------------------------

export type TranscriptQueueBatch = {
  generatedAt: Date;
  enabled: boolean;
  /** QUEUED + RUNNING + NEEDS_REVIEW + FAILED. */
  total: number;
  queued: number;
  running: number;
  needsReview: number;
  failed: number;
  /** QUEUED only. */
  byKind: Record<string, number>;
  byRequester: Record<string, number>;
  clients: { clientId: string | null; name: string; tier: "TEST" | "PILOT" | "REAL" | "UNKNOWN"; jobs: number }[];
  oldestQueuedAt: Date | null;
  /** A handler exists, nextAttemptAt has passed, the kind's own switch is on, and no backlog or rollout hold. */
  runnableNow: number;
  /** Of the runnable, the one that has been runnable longest (for "queue not draining"). */
  oldestRunnableSince: Date | null;
  /** Held because the kind's own switch is off. */
  waitingOnOwner: number;
  heldBacklog: number;
  heldScope: number;
  waitingForHandler: number;
  /** Queued jobs, per kind, that will not run: their owning switch is off. */
  ownerOff: { kind: string; owner: AutomationKey; jobs: number }[];
  /** Every queued kind but INGEST spends AI credit. */
  aiJobs: number;
  perTick: number;
  ticksToDrain: number;
  backlog: BacklogCutoff & { skipped: number };
  /** "Queued now: 7 jobs (INGEST 2 · ANALYZE 3 · STRATEGY_DRAFT 2) · oldest Sep 12". */
  queuedNowLine: string;
  /** The whole picture in one line, for readiness and the switch-on confirm. */
  line: string;
};

/**
 * Why ONE job would wait if the processor looked at it now (review fix, Sep
 * 28 2026): the same HoldContext the batch and the driver build, the same
 * holdReasonFor, plus the two switches the whole queue needs. The owner's
 * Re-run used to promise "the next hourly run" for a job the driver would keep
 * holding (a client outside the rollout, a draft whose own switch is off, a
 * re-armed backlog job). Read-only. null when the job is gone.
 */
export async function transcriptJobHold(jobId: string, now: Date = new Date()): Promise<null | { processorOn: boolean; aiRunsOn: boolean; kind: string; hold: { kind: HoldKind; reason: string } | null }> {
  const job = await prisma.programTranscriptJob.findUnique({ where: { id: jobId }, select: { id: true, kind: true, createdAt: true, attempts: true, callRecordId: true, enrollmentId: true } });
  if (!job) return null;
  const [proc, handlers, { rollout }, aiRunsOn] = await Promise.all([processorState(), availableHandlers(), rolloutForProcessor(), isAutomationEnabled("ai_runs")]);
  const owners = [...new Set(Object.values(KIND_OWNER))] as AutomationKey[];
  const ownerOn = Object.fromEntries(await Promise.all(owners.map(async (k) => [k, await isAutomationEnabled(k)] as const))) as Partial<Record<AutomationKey, boolean>>;
  const ctx: HoldContext = {
    runnableKinds: TRANSCRIPT_JOB_KINDS.filter((k) => typeof handlers[k] === "function"),
    ownerOn,
    backlog: backlogCutoff(proc.unreadable ? null : proc.cfg, proc.enabledAt, now),
    rollout,
    now,
  };
  const client = (await clientsForJobs([job])).get(clientKey(job)) ?? null;
  return { processorOn: proc.enabled, aiRunsOn, kind: job.kind, hold: holdReasonFor(job, client, ctx) };
}

export async function transcriptQueueBatch(now: Date = new Date()): Promise<TranscriptQueueBatch> {
  const [proc, handlers, { rollout }, rows] = await Promise.all([
    processorState(),
    availableHandlers(),
    rolloutForProcessor(),
    prisma.programTranscriptJob.findMany({
      where: { state: { in: ["QUEUED", "RUNNING", "NEEDS_REVIEW", "FAILED"] } },
      select: { id: true, kind: true, state: true, createdAt: true, attempts: true, nextAttemptAt: true, callRecordId: true, enrollmentId: true, requestedBy: true, lastError: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const owners = [...new Set(Object.values(KIND_OWNER))] as AutomationKey[];
  const ownerOn = Object.fromEntries(await Promise.all(owners.map(async (k) => [k, await isAutomationEnabled(k)] as const))) as Partial<Record<AutomationKey, boolean>>;
  const runnableKinds = TRANSCRIPT_JOB_KINDS.filter((k) => typeof handlers[k] === "function");
  const backlog = backlogCutoff(proc.unreadable ? null : proc.cfg, proc.enabledAt, now);
  const ctx: HoldContext = { runnableKinds, ownerOn, backlog, rollout, now };
  const queuedRows = rows.filter((r) => r.state === "QUEUED");
  const jobClients = await clientsForJobs(rows);

  const byKind: Record<string, number> = {};
  const byRequester: Record<string, number> = {};
  const perClient = new Map<string, { clientId: string | null; name: string; tier: TranscriptQueueBatch["clients"][number]["tier"]; jobs: number }>();
  const ownerOffCount = new Map<string, number>();
  let runnableNow = 0, waitingOnOwner = 0, heldBacklog = 0, heldScope = 0, waitingForHandler = 0, aiJobs = 0;
  let oldestRunnableSince: Date | null = null;
  for (const j of queuedRows) {
    byKind[j.kind] = (byKind[j.kind] ?? 0) + 1;
    const who = j.requestedBy ?? "(none)";
    byRequester[who] = (byRequester[who] ?? 0) + 1;
    if (j.kind !== "INGEST") aiJobs++;
    const client = jobClients.get(clientKey(j)) ?? null;
    const key = client?.id ?? "(unknown)";
    const cur = perClient.get(key) ?? { clientId: client?.id ?? null, name: client?.name ?? "client not confirmed yet", tier: client ? clientTier(rollout, client, now) : "UNKNOWN", jobs: 0 };
    cur.jobs++;
    perClient.set(key, cur);
    const h = holdReasonFor(j, client, ctx);
    if (h?.kind === "owner") { waitingOnOwner++; ownerOffCount.set(j.kind, (ownerOffCount.get(j.kind) ?? 0) + 1); }
    else if (h?.kind === "backlog") heldBacklog++;
    else if (h?.kind === "scope") heldScope++;
    else if (h?.kind === "handler") waitingForHandler++;
    else if (!j.nextAttemptAt || j.nextAttemptAt.getTime() <= now.getTime()) {
      runnableNow++;
      // Runnable since the latest of: queued, its retry time (the driver
      // stamps it when a hold lifts and when a full tick passes the job by),
      // the switch-on — and NOW for a job still carrying a hold mark: its
      // hold lifted after the last tick, so no tick has had the chance yet.
      const since = new Date(Math.max(j.createdAt.getTime(), j.nextAttemptAt?.getTime() ?? 0, proc.enabled && proc.enabledAt ? proc.enabledAt.getTime() : 0, isHoldMark(j.lastError) ? now.getTime() : 0));
      if (!oldestRunnableSince || since < oldestRunnableSince) oldestRunnableSince = since;
    }
  }
  const clients = [...perClient.values()].sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));
  const oldestQueuedAt = queuedRows[0]?.createdAt ?? null;
  const perTick = TRANSCRIPT_JOBS_PER_TICK;
  const kinds = TRANSCRIPT_JOB_KINDS.filter((k) => byKind[k]).map((k) => `${k} ${byKind[k]}`).join(" · ");
  const queuedNowLine = queuedRows.length
    ? `Queued now: ${queuedRows.length} job${queuedRows.length === 1 ? "" : "s"} (${kinds}) · oldest ${etMonthDay(oldestQueuedAt)}`
    : "Queued now: nothing";
  const real = clients.filter((c) => c.tier === "REAL");
  const pieces: string[] = [];
  if (queuedRows.length) {
    pieces.push(`${queuedRows.length} waiting: ${kinds} for ${clients.length} client${clients.length === 1 ? "" : "s"}${real.length ? ` (${real.length} real: ${real.slice(0, 4).map((c) => c.name).join(", ")}${real.length > 4 ? "…" : ""})` : ""}`);
    pieces.push(`oldest ${etMonthDay(oldestQueuedAt)}`);
    if (heldBacklog) {
      pieces.push(backlog.source === "never_on"
        ? `the ${heldBacklog} already waiting will be SKIPPED when it is switched on (only jobs queued after that run) unless you include them`
        : `${heldBacklog} queued before ${etMonthDay(backlog.cutoff)} are skipped unless you include them`);
    }
    if (heldScope) pieces.push(`${heldScope} for clients outside the rollout wait (internal AI runs only for TEST and pilot clients)`);
    for (const [kind, n] of ownerOffCount) pieces.push(`${n} ${kind} wait for ${KIND_OWNER[kind as TranscriptJobKind]} to be on`);
    pieces.push(runnableNow ? `the ${proc.enabled ? "next" : "first"} run takes ${Math.min(perTick, runnableNow)} of the ${runnableNow} runnable` : "nothing is runnable");
    if (aiJobs) pieces.push("each AI job spends credit");
  } else {
    pieces.push("nothing waiting");
  }
  const failedN = rows.filter((r) => r.state === "FAILED").length;
  const reviewN = rows.filter((r) => r.state === "NEEDS_REVIEW").length;
  if (reviewN) pieces.push(`${reviewN} need a person`);
  return {
    generatedAt: now,
    enabled: proc.enabled,
    total: rows.length,
    queued: queuedRows.length,
    running: rows.filter((r) => r.state === "RUNNING").length,
    needsReview: reviewN,
    failed: failedN,
    byKind, byRequester, clients, oldestQueuedAt,
    runnableNow, oldestRunnableSince,
    waitingOnOwner, heldBacklog, heldScope, waitingForHandler,
    ownerOff: [...ownerOffCount].map(([kind, jobs]) => ({ kind, owner: KIND_OWNER[kind as TranscriptJobKind]!, jobs })),
    aiJobs, perTick, ticksToDrain: Math.ceil(runnableNow / perTick),
    backlog: { ...backlog, skipped: heldBacklog },
    queuedNowLine,
    line: `${proc.enabled ? "on" : "off"} — ${pieces.join(" · ")}`,
  };
}
