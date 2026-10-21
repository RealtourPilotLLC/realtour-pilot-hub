import "server-only";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { lockAdvisory } from "@/lib/dbLocks";
import { LEASE_MS, QUEUE_LEASE_PREFIX, assertQuota, expireStaleRuns, type AiRunKind, type ClaimedRun } from "@/lib/aiRuns";

// ---------------------------------------------------------------------------
// THE CONTENT AI QUEUE (Oct 12 2026). Jordan: "When I click Draft Script on a
// video topic, I want a message to pop up to confirm it's been sent for
// scripting. Right now, it makes me wait till it's done. I want it done in the
// background so I can continue clicking Draft Script for all of the other
// topics." His standing rule: every action works instantly.
//
// THE CLICK is database-only: it validates, writes ONE ProgramAiRun row —
// status QUEUED, holding the generator's own dedupe key, attributed to the
// person — and answers. The row is the durable "drafting" marker the page
// reads across refreshes, and the key is the claim: a double click, a second
// tab or the scheduled sweep collides on it (Postgres, unique dedupeKey), so a
// topic is never drafted twice.
//
// THE WORK runs in a worker the click hands to after() (and the poll, and the
// 15-minute AI work job, cron/topics): it claims the oldest QUEUED row under a lease
// ("queue:<origin>:<id>") and the generator ADOPTS that row (runAiJson's
// claimedRun) — one row per draft from the click to the version, never a
// second run for the same draft.
//
// AT MOST QUEUE_CONCURRENCY RUN AT ONCE, program-wide. Eight clicks start
// eight workers; three claim, five find the cap full and leave their rows
// QUEUED; each running worker takes the next one when it finishes. The count
// and the claim happen under one advisory lock, so two workers can never both
// take the third slot.
//
// STRANDED WORK COMES BACK. after() lives inside the page's 300 s ceiling and a
// deploy can kill it. A queue-owned RUNNING row past its 10-minute lease is put
// back to QUEUED (runAiJson's own cleanup leaves queue rows to us) and retried
// — up to QUEUE_MAX_ATTEMPTS claims — by the next worker: the page's poll
// starts one while anything is waiting, and the 15-minute AI work job
// (cron/topics, Oct 13 2026 — it used to be the hourly cron/sync) drains the
// rest when nobody is looking, starting a draft only with time to finish it.
//
// ATTENDED. A queued job is a person's click carried out later: it runs with
// unattended=false whatever the automation switches say (the ai_runs switch
// gates sweeps, not clicks), attributed to that person, and the daily AI
// quotas apply exactly as they did when the click waited.
// ---------------------------------------------------------------------------

export const QUEUE_CONCURRENCY = 3;
export const QUEUE_MAX_ATTEMPTS = 3;
/** A worker started by a click stops claiming after this, so the draft it takes last still ends inside the page's 300 s. */
export const WORKER_BUDGET_MS = 170_000;
const LOCK = "program-ai-queue";
/** Every queued row's scope says so — the queue's own rows, and nothing runAiJson made. */
const VIA = '"via":"queue"';

export type QueueJob =
  /** "Draft script" on one topic, and a topic-path owed draft (call excerpts or the topic alone). */
  | { job: "script_topic"; topicId: string; monthId: string; callRecordId?: string | null; selectedOnCall?: boolean }
  /** An owed draft from the client's written answers. */
  | {
      job: "script_interview"; topicId: string; monthId: string; interviewId: string;
      /** Default true: a script that appeared since the click stops it. False is a person's "New draft from the changed answers", the next version of the script the topic already has (Oct 20 2026). */
      onlyIfUnscripted?: boolean;
      /** With onlyIfUnscripted false: the script the new version lands on, where the page shows the job. */
      scriptId?: string;
    }
  /** "Ask AI to revise" and "Tighten" on a script — a new version; the current one is kept. */
  | {
      job: "script_revise"; scriptId: string; instruction: string; label: "revise" | "tighten"; /** Oct 14 2026: "Keep exactly" sections, copied back by code. */ lockSections?: string[];
      /** Oct 20 2026: CLIENT_REQUEST when the words are a portal request ("Apply with AI"). Default REVISION. */
      source?: "REVISION" | "CLIENT_REQUEST";
      /** "Apply with AI": the request this revision applies. Stamped APPLIED (by AI, with the version) once the version lands; opened again if the job stops first. */
      suggestionId?: string;
    }
  /** "Draft from the discovery call". */
  | { job: "strategy_draft"; callRecordId: string };

type StoredScope = QueueJob & { via: "queue"; title?: string | null };

/** The generator's OWN dedupe key — so a queued row and a sweep's run of the same work collide. */
export function queueKey(j: QueueJob): string {
  switch (j.job) {
    case "script_topic": return `script:${j.topicId}:${j.monthId}`;
    case "script_interview": return `script:interview:${j.interviewId}`;
    case "script_revise": return `revise:${j.scriptId}`;
    case "strategy_draft": return `strategy:${j.callRecordId}`;
  }
}

function kindOf(j: QueueJob): AiRunKind {
  return j.job === "script_revise" ? "script_revise" : j.job === "strategy_draft" ? "strategy_draft" : "script_draft";
}

function busyLine(j: QueueJob): string {
  if (j.job === "script_revise") return "That script is already being revised — the new version appears on it when it's ready.";
  if (j.job === "strategy_draft") return "The strategy is already being drafted — it appears under Strategy versions when it's ready.";
  return "That topic is already being drafted — it'll appear on the Scripts tab when it's ready.";
}

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002" || String(e).includes("Unique constraint");

export type EnqueueResult = { ok: true; runId: string } | { ok: false; message: string; runId: string | null };

/**
 * Put one job on the queue. Database-only — this is the click's whole cost.
 * Refuses (ok:false) when the same work is already queued or running, by the
 * queue or by anything else holding the generator's key, and when a daily AI
 * quota is already spent (the run would only fail later).
 */
export async function enqueueAiJob(o: { job: QueueJob; enrollmentId: string; clientId: string; requestedBy: string; title?: string | null; now?: Date }): Promise<EnqueueResult> {
  const now = o.now ?? new Date();
  // A dead holder of this key must not refuse the click: a stranded queue row
  // goes back to QUEUED (and then reads as "already queued"), a dead run of
  // anyone else's is expired.
  await settleStaleRuns(now);
  try {
    await assertQuota(kindOf(o.job), o.enrollmentId);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), runId: null };
  }
  const key = queueKey(o.job);
  const scope: StoredScope = { ...o.job, via: "queue", title: o.title ?? null };
  try {
    const row = await prisma.programAiRun.create({
      data: {
        kind: kindOf(o.job), enrollmentId: o.enrollmentId, clientId: o.clientId, scopeJson: JSON.stringify(scope), promptKey: `queue:${o.job.job}`,
        status: "QUEUED", attempts: 0, requestedBy: o.requestedBy, dedupeKey: key, nextAttemptAt: now,
      },
      select: { id: true },
    });
    return { ok: true, runId: row.id };
  } catch (e) {
    if (!isUnique(e)) throw e;
    const holder = await prisma.programAiRun.findUnique({ where: { dedupeKey: key }, select: { id: true } });
    return { ok: false, message: busyLine(o.job), runId: holder?.id ?? null };
  }
}

/** Both cleanups: stranded queue rows back to QUEUED, anyone else's dead runs expired (their keys freed). */
export async function settleStaleRuns(now: Date = new Date()): Promise<void> {
  await recoverStaleQueuedRuns(now);
  await expireStaleRuns(now);
}

/**
 * A queue row left RUNNING past its lease — its worker was killed (after()'s
 * ceiling, a deploy) — goes back to QUEUED with the reason on it, and is
 * claimed again by the next worker. After QUEUE_MAX_ATTEMPTS claims it stops:
 * FAILED, key freed, and the page says "Try again". Fenced on the exact lease
 * it read, so a worker that renewed it in the meantime keeps it.
 */
export async function recoverStaleQueuedRuns(now: Date = new Date()): Promise<{ requeued: number; failed: number }> {
  const stale = await prisma.programAiRun.findMany({
    where: { status: "RUNNING", leaseBy: { startsWith: QUEUE_LEASE_PREFIX }, leaseUntil: { lt: now } },
    select: { id: true, attempts: true, leaseBy: true, leaseUntil: true },
    take: 100,
  });
  let requeued = 0, failed = 0;
  for (const r of stale) {
    const fence = { id: r.id, status: "RUNNING", leaseBy: r.leaseBy, leaseUntil: r.leaseUntil };
    if (r.attempts < QUEUE_MAX_ATTEMPTS) {
      const u = await prisma.programAiRun.updateMany({
        where: fence,
        data: { status: "QUEUED", leaseBy: null, leaseUntil: null, nextAttemptAt: now, error: `Interrupted on try ${r.attempts} (the server stopped before it finished) — queued again.`, errorAt: now },
      });
      requeued += u.count;
    } else {
      const u = await prisma.programAiRun.updateMany({
        where: fence,
        data: { status: "FAILED", leaseBy: null, leaseUntil: null, dedupeKey: null, finishedAt: now, error: `Interrupted ${r.attempts} times before it finished — not tried again.`, errorAt: now },
      });
      failed += u.count;
    }
  }
  return { requeued, failed };
}

type ClaimedRow = { id: string; scopeJson: string | null; requestedBy: string | null; enrollmentId: string | null; leaseBy: string };

/** Claim the oldest QUEUED row if a slot is free. Count and claim under one lock: never more than QUEUE_CONCURRENCY. */
async function claimNext(origin: string): Promise<ClaimedRow | null> {
  return prisma.$transaction(async (tx) => {
    await lockAdvisory(tx, LOCK);
    const now = new Date();
    const running = await tx.programAiRun.count({ where: { status: "RUNNING", leaseBy: { startsWith: QUEUE_LEASE_PREFIX }, leaseUntil: { gt: now } } });
    if (running >= QUEUE_CONCURRENCY) return null;
    const next = await tx.programAiRun.findFirst({
      where: { status: "QUEUED", scopeJson: { contains: VIA }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      orderBy: { createdAt: "asc" },
      select: { id: true, scopeJson: true, requestedBy: true, enrollmentId: true },
    });
    if (!next) return null;
    const leaseBy = `${QUEUE_LEASE_PREFIX}${origin}:${randomUUID().slice(0, 8)}`;
    const r = await tx.programAiRun.updateMany({
      where: { id: next.id, status: "QUEUED" },
      data: { status: "RUNNING", leaseBy, leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 }, startedAt: now, nextAttemptAt: null },
    });
    return r.count ? { ...next, leaseBy } : null;
  }, { maxWait: 10_000, timeout: 20_000 });
}

export type JobOutcome = "done" | "failed" | "cancelled" | "lost";

/** Run one claimed row through its generator, which adopts the row. Never throws: the outcome is on the row. */
async function runClaimed(row: ClaimedRow, checkDeadline: number | null = null): Promise<JobOutcome> {
  const claimed: ClaimedRun = { id: row.id, leaseBy: row.leaseBy };
  const by = row.requestedBy ?? "queue";
  let scope: StoredScope | null = null;
  try { scope = row.scopeJson ? (JSON.parse(row.scopeJson) as StoredScope) : null; } catch { scope = null; }
  try {
    if (!scope) throw new Error("This queued job has no readable request on it.");
    switch (scope.job) {
      case "script_topic": {
        const { generateScriptForTopic } = await import("@/lib/contentGeneration");
        // onlyIfUnscripted: a script that appeared since the click (the
        // hourly sweep, an upload) is not given a second version by it.
        await generateScriptForTopic({ topicId: scope.topicId, monthId: scope.monthId, requestedBy: by, unattended: false, callRecordId: scope.callRecordId ?? null, selectedOnCall: scope.selectedOnCall ?? true, onlyIfUnscripted: true, claimedRun: claimed, checkDeadline });
        break;
      }
      case "script_interview": {
        const { generateScriptFromInterview } = await import("@/lib/contentGeneration");
        await generateScriptFromInterview(scope.interviewId, by, { unattended: false, onlyIfUnscripted: scope.onlyIfUnscripted ?? true, claimedRun: claimed, checkDeadline });
        break;
      }
      case "script_revise": {
        const { reviseScript } = await import("@/lib/contentGeneration");
        const { asLockSections } = await import("@/lib/contentPolicy");
        const v = await reviseScript(scope.scriptId, scope.instruction, by, scope.source ?? "REVISION", { claimedRun: claimed, lockSections: asLockSections(scope.lockSections) });
        // "Apply with AI" (Oct 20 2026): the request is kept on the card as
        // APPLIED by AI, pointing at the version it became. Best effort: the
        // version is written, so a failure here must not read as the job's.
        if (scope.suggestionId) {
          const { settleAiApply } = await import("@/lib/scriptRequests");
          await settleAiApply(scope.suggestionId, v.versionId, by).catch((e) => console.error("[aiQueue] could not mark the request applied:", e));
        }
        break;
      }
      case "strategy_draft": {
        if (!row.enrollmentId) throw new Error("This queued strategy draft names no client.");
        const { draftStrategyNow } = await import("@/lib/programOnboarding");
        await draftStrategyNow(row.enrollmentId, by, { claimedRun: claimed });
        break;
      }
      default:
        throw new Error("Unknown queued job.");
    }
    return "done";
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    // The queue took the row back (its lease ran out) or another run replaced
    // it — that run does the work; this one writes nothing.
    if (name === "LeaseLostError") return "lost";
    // "Apply with AI" stopped before a version: the request is open again (its words untouched).
    if (scope?.job === "script_revise" && scope.suggestionId) {
      const { releaseAiApply } = await import("@/lib/scriptRequests");
      await releaseAiApply(scope.suggestionId).catch(() => {});
    }
    const msg = ((e instanceof Error ? e.message : String(e)).split("\n")[0] || "unknown error").slice(0, 600);
    const already = name === "AlreadyDraftedError";
    const now = new Date();
    // Refused before the model ran (still RUNNING under this lease): close it.
    // A run the model already answered is SUCCEEDED (runAiJson) — say on it
    // why its output was not saved, so the page can show the reason.
    const closed = await prisma.programAiRun.updateMany({
      where: { id: row.id, status: "RUNNING", leaseBy: row.leaseBy },
      data: {
        status: already ? "CANCELLED" : name === "QuotaExceededError" ? "QUOTA_BLOCKED" : "FAILED",
        error: already ? "Already drafted — a script for this topic appeared before this draft ran; nothing was spent." : msg,
        errorAt: now, finishedAt: now, dedupeKey: null, leaseUntil: null, leaseBy: null,
      },
    });
    if (!closed.count) {
      await prisma.programAiRun.updateMany({
        where: { id: row.id, status: "SUCCEEDED", outputRef: null },
        data: { error: already ? "Already drafted by another run — this output was kept here and not used." : `The draft came back but was not saved: ${msg}`, errorAt: now },
      }).catch(() => {});
    }
    return already ? "cancelled" : "failed";
  }
}

export type DrainResult = { ran: number; done: number; failed: number; cancelled: number; lost: number; requeued: number };

/**
 * One worker: claim → run → claim the next, until nothing is waiting, the
 * cap is full, or the budget is spent (whatever it has claimed, it finishes).
 */
export async function drainAiQueue(opts: { origin?: string; budgetMs?: number; max?: number; minStartMs?: number } = {}): Promise<DrainResult> {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? WORKER_BUDGET_MS;
  const max = opts.max ?? 25;
  // Oct 13 2026: the scheduled worker claims a job only with the time to finish
  // it — a draft started with seconds left was stopped mid-call and came back
  // QUEUED an attempt down. 0 keeps the old rule (the click's own worker).
  const minStartMs = opts.minStartMs ?? 0;
  const origin = (opts.origin ?? "worker").replace(/[^a-z0-9-]/gi, "").slice(0, 20) || "worker";
  const out: DrainResult = { ran: 0, done: 0, failed: 0, cancelled: 0, lost: 0, requeued: 0 };
  out.requeued = (await recoverStaleQueuedRuns().catch(() => ({ requeued: 0, failed: 0 }))).requeued;
  while (out.ran < max && Date.now() - started < budgetMs && budgetMs - (Date.now() - started) >= minStartMs) {
    const row = await claimNext(origin);
    if (!row) break;
    out.ran++;
    // Oct 14 2026: the draft's automatic check starts no model call past this worker's own budget (the AI cron finishes it).
    out[await runClaimed(row, started + budgetMs)]++;
  }
  return out;
}

/** The 15-minute AI work job (cron/topics): up to QUEUE_CONCURRENCY workers side by side (the cap still holds — they share it). */
export async function drainAiQueueInParallel(opts: { origin?: string; budgetMs?: number; minStartMs?: number; maxPerWorker?: number } = {}): Promise<DrainResult & { waiting: number }> {
  const results = await Promise.all(Array.from({ length: QUEUE_CONCURRENCY }, () => drainAiQueue({ origin: opts.origin ?? "cron", budgetMs: opts.budgetMs, minStartMs: opts.minStartMs, max: opts.maxPerWorker })));
  const sum = results.reduce<DrainResult>((a, r) => ({ ran: a.ran + r.ran, done: a.done + r.done, failed: a.failed + r.failed, cancelled: a.cancelled + r.cancelled, lost: a.lost + r.lost, requeued: a.requeued + r.requeued }), { ran: 0, done: 0, failed: 0, cancelled: 0, lost: 0, requeued: 0 });
  const waiting = await prisma.programAiRun.count({ where: { status: "QUEUED", scopeJson: { contains: VIA } } });
  return { ...sum, waiting };
}

/** Is a worker worth starting? Something QUEUED and a free slot. */
export async function queueWantsWorker(now: Date = new Date()): Promise<boolean> {
  const [queued, running] = await Promise.all([
    prisma.programAiRun.count({ where: { status: "QUEUED", scopeJson: { contains: VIA }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] } }),
    prisma.programAiRun.count({ where: { status: "RUNNING", leaseBy: { startsWith: QUEUE_LEASE_PREFIX }, leaseUntil: { gt: now } } }),
  ]);
  return queued > 0 && running < QUEUE_CONCURRENCY;
}

// ---------------------------------------------------------------------------
// WHAT THE PAGE SHOWS — per topic, per script, for the strategy.
// ---------------------------------------------------------------------------

export type QueueItemUi = {
  /** queued: waiting for a slot · running: with the model · failed: stopped, with the reason. */
  state: "queued" | "running" | "failed";
  runId: string;
  error: string | null;
  /** When the job was asked for (ISO). */
  at: string;
  /** script_revise: "revise" | "tighten"; a re-draft from changed answers: "redraft". */
  label?: string | null;
};
export type QueueStateUi = {
  /** Month-scoped script drafts, by topic id. */
  topics: Record<string, QueueItemUi>;
  /** Revisions, by script id. */
  scripts: Record<string, QueueItemUi>;
  strategy: QueueItemUi | null;
  /** Everything in flight for the client (activeQueueRuns) — what the page's poll compares against. */
  active: string[];
};

/**
 * The newest queued job per subject, for one client (and month). Done jobs
 * (SUCCEEDED, CANCELLED) say nothing — the script or version they made does.
 * A failure is shown until something newer replaces it; the caller drops one
 * the subject has since moved past (a script now exists, a newer version).
 */
export async function queueStateFor(enrollmentId: string, opts: { monthId?: string | null; now?: Date } = {}): Promise<QueueStateUi> {
  const now = opts.now ?? new Date();
  const rows = await prisma.programAiRun.findMany({
    where: { enrollmentId, scopeJson: { contains: VIA }, createdAt: { gte: new Date(now.getTime() - 14 * 864e5) } },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, status: true, error: true, outputRef: true, scopeJson: true, createdAt: true },
  });
  const out: QueueStateUi = { topics: {}, scripts: {}, strategy: null, active: await activeQueueRuns(enrollmentId) };
  const seen = new Set<string>();
  for (const r of rows) {
    let s: StoredScope | null = null;
    try { s = r.scopeJson ? (JSON.parse(r.scopeJson) as StoredScope) : null; } catch { s = null; }
    if (!s) continue;
    // A re-draft from changed answers shows on its script, like a revision (it is that script's next version).
    const onScript = s.job === "script_revise" ? s.scriptId : s.job === "script_interview" && s.onlyIfUnscripted === false ? s.scriptId ?? null : null;
    const topic = s.job === "script_topic" || s.job === "script_interview" ? { topicId: s.topicId, monthId: s.monthId } : null;
    const subject = onScript ? `script:${onScript}` : topic ? `topic:${topic.topicId}:${topic.monthId}` : "strategy";
    if (seen.has(subject)) continue;
    seen.add(subject);
    const state: QueueItemUi["state"] | null =
      r.status === "QUEUED" ? "queued"
      : r.status === "RUNNING" ? "running"
      : r.status === "FAILED" || r.status === "QUOTA_BLOCKED" ? "failed"
      : r.status === "SUCCEEDED" && !r.outputRef && r.error && !/^Already drafted/.test(r.error) ? "failed"
      : null;
    if (!state) continue;
    const item: QueueItemUi = { state, runId: r.id, error: state === "failed" ? r.error ?? "It stopped without saying why." : null, at: r.createdAt.toISOString(), label: s.job === "script_revise" ? s.label : onScript ? "redraft" : null };
    if (onScript) out.scripts[onScript] = item;
    else if (topic) { if (!opts.monthId || topic.monthId === opts.monthId) out.topics[topic.topicId] = item; }
    else if (s.job === "strategy_draft") out.strategy = item;
  }
  return out;
}

/**
 * Everything still in flight for one client — queued AI jobs and a running
 * topic refresh (which runs in the background too). The page renders this
 * list and the poll compares against it, so both MUST come from here: any
 * difference reads as "something finished" and refreshes the page.
 */
export async function activeQueueRuns(enrollmentId: string): Promise<string[]> {
  const [jobs, refreshes] = await Promise.all([
    prisma.programAiRun.findMany({ where: { enrollmentId, scopeJson: { contains: VIA }, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } }),
    prisma.contentTopicRefreshRun.findMany({ where: { enrollmentId, status: "RUNNING", kind: { in: ["BANK", "REFRESH"] } }, select: { id: true } }),
  ]);
  return [...jobs.map((r) => r.id), ...refreshes.map((r) => `refresh:${r.id}`)].sort();
}

/**
 * Portal requests whose "Apply with AI" is still queued or running (Oct 20
 * 2026). Their APPLYING claim is live however long the queue takes, so the
 * ten-minute reopen of a dead claim (scriptRequests) leaves them alone.
 */
export async function suggestionsInFlight(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!ids.length) return out;
  const rows = await prisma.programAiRun.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, scopeJson: { contains: VIA }, OR: ids.map((id) => ({ scopeJson: { contains: `"suggestionId":${JSON.stringify(id)}` } })) },
    select: { scopeJson: true },
  });
  for (const r of rows) {
    try {
      const s = JSON.parse(r.scopeJson ?? "") as StoredScope;
      if (s.job === "script_revise" && s.suggestionId && ids.includes(s.suggestionId)) out.add(s.suggestionId);
    } catch { /* unreadable scope: not a live claim */ }
  }
  return out;
}

/** The stored request of a queued run — what "Try again" re-asks for. */
export async function queuedJobOf(runId: string): Promise<{ job: QueueJob; enrollmentId: string | null; clientId: string | null; title: string | null; status: string } | null> {
  const r = await prisma.programAiRun.findUnique({ where: { id: runId }, select: { scopeJson: true, enrollmentId: true, clientId: true, status: true } });
  if (!r?.scopeJson || !r.scopeJson.includes(VIA)) return null;
  let s: StoredScope;
  try { s = JSON.parse(r.scopeJson) as StoredScope; } catch { return null; }
  const job = jobOf(s);
  return job ? { job, enrollmentId: r.enrollmentId, clientId: r.clientId, title: s.title ?? null, status: r.status } : null;
}

/** The request alone — a run's scope also carries what its generator added (basedOnVersionId, …). */
function jobOf(s: StoredScope): QueueJob | null {
  switch (s.job) {
    case "script_topic": return { job: s.job, topicId: s.topicId, monthId: s.monthId, callRecordId: s.callRecordId ?? null, selectedOnCall: s.selectedOnCall ?? true };
    case "script_interview": return { job: s.job, topicId: s.topicId, monthId: s.monthId, interviewId: s.interviewId, ...(s.onlyIfUnscripted === false ? { onlyIfUnscripted: false, ...(s.scriptId ? { scriptId: s.scriptId } : {}) } : {}) };
    case "script_revise": return {
      job: s.job, scriptId: s.scriptId, instruction: s.instruction, label: s.label, ...(Array.isArray(s.lockSections) && s.lockSections.length ? { lockSections: s.lockSections } : {}),
      ...(s.source ? { source: s.source } : {}), ...(s.suggestionId ? { suggestionId: s.suggestionId } : {}),
    };
    case "strategy_draft": return { job: s.job, callRecordId: s.callRecordId };
    default: return null;
  }
}
