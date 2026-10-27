import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { aiJsonWithUsage, aiStructuredWithUsage, WRITER_MODEL, type AiUsage, type AiEffort, type PromptBlock } from "@/lib/integrations/ai";
import { aiCostUsd } from "@/lib/aiUsage";
import { GENERATION_POLICY, GENERATION_POLICY_HASH, GENERATION_POLICY_VERSION, STRATEGY_TEMPLATE, policyRulesText } from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// Every Content Program AI call is a ProgramAiRun (spec §13): who asked, for
// which client, from which inputs, with which prompt/model/policy version,
// what it cost, and what a human did with the result. aiJson() used to throw
// the usage block away and the hourly cron spent unbounded money on nothing
// anyone could see — this ledger is the fix.
//
// Two gates, deliberately separate:
//   • ai_runs (ProgramAutomation) gates UNATTENDED runs only. A staff member
//     clicking "Generate" in the workspace is a user action and is allowed
//     while the switch is off; it is still logged here.
//   • ProgramAiQuota caps runs per enrollment per day (and per kind, and
//     globally). A missing quota row applies the conservative code default.
// ---------------------------------------------------------------------------

export class AutomationDisabledError extends Error {
  constructor(msg = "AI runs are switched off for unattended jobs (Settings → AI Assistants).") {
    super(msg);
    this.name = "AutomationDisabledError";
  }
}
export class QuotaExceededError extends Error {
  /**
   * Which cap refused (Oct 22 2026): "client" = this one client's daily cap,
   * so a sweep moves on to the next client; "program" = the program-wide or
   * per-kind cap, which refuses everyone alike.
   */
  readonly scope: "client" | "program";
  constructor(msg: string, scope: "client" | "program" = "program") {
    super(msg);
    this.name = "QuotaExceededError";
    this.scope = scope;
  }
}

/**
 * OFFLINE AND TEST RUNS ARE NOT THE CLIENT'S (Oct 22 2026). A run requested by
 * "claude:<job>" (a test or a one-off a developer ran from a script) or one
 * scoped `offline: true` (the writer's retro tests, which write nothing but the
 * run row) is real spend, so it still counts toward the program-wide and
 * per-kind caps, but never toward the client's own daily cap. On Oct 22 Erica
 * reached 40 of 40 (23 of them tests), John 38 (all tests) and Marcee 33 (all
 * tests): her restored drafts were refused, the 15-minute check sweep stopped
 * at the refusal and portal AI was refused for those clients.
 */
export const OFFLINE_REQUESTER_PREFIX = "claude:";
export const OFFLINE_SCOPE_MARK = '"offline":true';
export function isOfflineRun(requestedBy: string | null | undefined, scope?: Record<string, unknown> | string | null): boolean {
  if ((requestedBy ?? "").startsWith(OFFLINE_REQUESTER_PREFIX)) return true;
  if (!scope) return false;
  if (typeof scope === "string") return scope.includes(OFFLINE_SCOPE_MARK);
  return scope.offline === true;
}
/**
 * The run rows a client's cap counts: everything but offline and test runs.
 * Both columns are nullable, and a bare NOT drops NULL rows in SQL, so each
 * test is "null, or not that".
 */
export const COUNTS_FOR_CLIENT_CAP = {
  AND: [
    { OR: [{ requestedBy: null }, { NOT: { requestedBy: { startsWith: OFFLINE_REQUESTER_PREFIX } } }] },
    { OR: [{ scopeJson: null }, { NOT: { scopeJson: { contains: OFFLINE_SCOPE_MARK } } }] },
  ],
};
/**
 * The model answered after this run's lease had run out and another caller had
 * already marked it FAILED and started its own (R04, Sep 28 2026). The answer
 * and its cost are kept on the FAILED row; nothing is applied from it.
 */
export class LeaseLostError extends Error {
  constructor(msg = "This AI run finished after its 10-minute lease ran out and another run took its place. Its output is kept on the run and was not used.") {
    super(msg);
    this.name = "LeaseLostError";
  }
}

/** How long a run (and, with holdDedupeKey, the write after it) holds its key. */
export const LEASE_MS = 10 * 60_000;

/**
 * THE QUEUE'S LEASES (Oct 12 2026, aiQueue.ts). A person's "Draft script" no
 * longer waits on the model: the click writes a QUEUED ProgramAiRun holding
 * the generator's own dedupe key, a background worker claims it (RUNNING,
 * leaseBy "queue:<worker>") and the generator ADOPTS that row through
 * `claimedRun` instead of creating a second one — one row per draft, from the
 * click to the version. A queue-owned row that outlives its lease is not
 * failed by the cleanup below: the queue puts it back (aiQueue.recoverStale)
 * so the draft a person asked for is retried, not dropped.
 */
export const QUEUE_LEASE_PREFIX = "queue:";
/** A queued run a worker holds: runAiJson adopts this row instead of creating one. */
export type ClaimedRun = { id: string; leaseBy: string };

export type AiRunKind =
  | "call_analysis" | "fact_extract" | "strategy_draft" | "topic_bank" | "topic_refresh" | "recommendation"
  | "interview_plan" | "script_draft" | "script_revise" | "creative_review" | "caption" | "transcript" | "script_match" | "profile_draft"
  | "import_split"
  // A08 (Sep 25 2026): a person's "revise the strategy with this feedback" —
  // staff-initiated only, never a sweep; writes a new version for review.
  | "strategy_revise"
  // Oct 14 2026: the automatic check after every AI script draft
  // (scriptJudge.ts), and the auto-built creative identity (creativeIdentity.ts).
  | "script_judge" | "creative_identity"
  // Oct 22 2026: the script writer's steps before and after the draft
  // (src/lib/scriptWriter): reading the calls for the topic, the topic brief,
  // the five hooks, and the independent creative review. The draft itself and
  // its fix rounds stay script_draft / script_revise.
  | "script_retrieval" | "script_brief" | "script_hooks" | "script_review"
  // Oct 27 2026 (Jordan: "AI should handle it"): sorting a client's call
  // knowledge where it is used (knowledgeCurator.ts), naming the client behind
  // a call the signals could not place (callAutoMatch.ts), and reading a
  // client's portal message for a complaint (contentComplaints.ts).
  | "knowledge_curation" | "call_match" | "complaint_check";

/**
 * The writer's steps that only ever run inside one script's draft or check
 * (Oct 22 2026). The daily caps per client and program-wide count the draft
 * and its revisions, as before; these ride along under their own per-kind cap,
 * so a month of scripts written with a brief and a review is not refused for
 * the steps the old writer did not have.
 */
export const WRITER_STEP_KINDS: readonly AiRunKind[] = ["script_retrieval", "script_brief", "script_hooks", "script_review"];

// A cost ESTIMATE for the run ledger, in cents — the invoice is the truth.
// Oct 22 2026 (writer v2.3, the model map): this table used to be a second
// copy of the prices and knew only Opus 5.5 of the new models, so a Sonnet 5.5
// or Haiku 5.5 run was priced as Sonnet 4.6 ($3 / $15). It now reads the one
// price table, lib/aiUsage (Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5
// $0.10 / $0.50; each model's own cache-read price; cache writes 1.25x input),
// so the run ledger and the usage ledger price a call the same way, cache
// reads and writes included. The rows the old table priced are unchanged.
export function estimateCostCents(model: string, u: AiUsage): number {
  return Math.round(aiCostUsd(model, u) * 100);
}

// Code defaults when no ProgramAiQuota row exists. Conservative on purpose:
// the biggest client has 13 topics a month; 40 runs a day per enrollment is
// a click-happy afternoon, not a loop.
const DEFAULT_QUOTA = { enrollmentPerDay: 40, globalPerDay: 400, kindPerDay: 200 } as const;

function dayStart(): Date {
  // Quotas count against a UTC day — a fixed, timezone-free window is what a
  // "runs today" ceiling needs; nobody reads this as a business-hours clock.
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Refuses with QuotaExceededError when a limit is reached. `excludeRunId` is a
 * queued run being adopted: it is already RUNNING, so it must not count itself.
 */
export async function assertQuota(kind: AiRunKind, enrollmentId: string | null, excludeRunId: string | null = null, opts: { offline?: boolean } = {}): Promise<void> {
  const since = dayStart();
  const rows = await prisma.programAiQuota.findMany({ where: { period: "DAY", enabled: true } });
  const limitFor = (scope: string, ref: string, fallback: number) => {
    const row = rows.find((r) => r.scope === scope && r.scopeRef === ref);
    return row?.maxRuns ?? fallback;
  };
  // Oct 22 2026: the writer's steps (WRITER_STEP_KINDS) are held to their own
  // per-kind cap only, and never count toward the client or program-wide caps.
  const step = WRITER_STEP_KINDS.includes(kind);
  const notSteps = { kind: { notIn: [...WRITER_STEP_KINDS] } };
  const checks: { where: Record<string, unknown>; max: number; what: string; scope: "client" | "program" }[] = [
    ...(step ? [] : [{ where: notSteps, max: limitFor("GLOBAL", "", DEFAULT_QUOTA.globalPerDay), what: "the program-wide daily AI limit", scope: "program" as const }]),
    { where: { kind }, max: limitFor("KIND", kind, DEFAULT_QUOTA.kindPerDay), what: `the daily limit for ${kind} runs`, scope: "program" },
  ];
  // Oct 22 2026: an offline or test run is held to the program-wide caps only,
  // and the client's cap counts none of them (isOfflineRun).
  if (enrollmentId && !step && !opts.offline) checks.push({ where: { enrollmentId, ...notSteps, ...COUNTS_FOR_CLIENT_CAP }, max: limitFor("ENROLLMENT", enrollmentId, DEFAULT_QUOTA.enrollmentPerDay), what: "this client's daily AI limit", scope: "client" });
  for (const c of checks) {
    const n = await prisma.programAiRun.count({ where: { ...c.where, startedAt: { gte: since }, status: { in: ["RUNNING", "SUCCEEDED", "FAILED"] }, ...(excludeRunId ? { id: { not: excludeRunId } } : {}) } });
    if (n >= c.max) throw new QuotaExceededError(`${c.what} (${c.max}/day) is reached — try again tomorrow or raise the quota.`, c.scope);
  }
}

export type RunAiOpts<T> = {
  kind: AiRunKind;
  enrollmentId?: string | null;
  clientId?: string | null;
  /** {monthId, topicId, scriptId, callRecordId, …} — what the run is about. */
  scope?: Record<string, unknown>;
  /** Record ids / hashes the prompt was built from. */
  inputRefs?: Record<string, unknown>;
  promptKey: string;
  promptVersion?: string;
  policyVersionId?: string | null;
  strategyVersionId?: string | null;
  /** staff email | "cron" | client user id. */
  requestedBy: string;
  /** true for cron/job drivers — gated by the ai_runs switch. false = a person clicked. */
  unattended: boolean;
  /** Collide duplicate requests on this key while one is active. */
  dedupeKey?: string | null;
  /**
   * Keep the dedupe key (and the lease) on the row after the model returns,
   * until the caller has WRITTEN what the run produced and calls
   * releaseRunKey(). Without it the key is freed the moment the model answers
   * — and a sweep holding a stale work list could claim the same topic again
   * in the gap before the script existed (Sep 24, cron-route-journey §4). A
   * crash in that gap frees the key when the lease runs out, like a dead run.
   */
  holdDedupeKey?: boolean;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  model?: string;
  /**
   * The model call's whole time limit (default aiTimeoutFor(maxTokens)). A
   * cron sweep passes what is left of its own budget (Oct 21 2026, audit H)
   * so one slow call cannot run past the function's deadline.
   */
  timeoutMs?: number;
  /** Called with the parsed output; its return value is stored as outputRef ("ContentScriptVersion:<id>"). */
  parse?: (out: T) => T;
  /**
   * A queued run this caller's worker has claimed (aiQueue.ts). The run is
   * that row — it already holds the dedupe key — so nothing is created, and
   * every write below is fenced on the worker's lease.
   */
  claimedRun?: ClaimedRun | null;
  /**
   * Oct 22 2026: "writer" = the script writer's model path
   * (integrations/ai.aiStructuredWithUsage: claude-opus-5-5, structured
   * output, an explicit effort). Unset = aiJsonWithUsage, as every other
   * feature has always run.
   */
  engine?: "writer" | null;
  /** The writer path's effort (required there; ignored elsewhere). */
  effort?: AiEffort | null;
  /** The writer path's prompt in blocks with cache breakpoints (v2.3; ignored elsewhere). Their texts joined are `prompt`. */
  promptBlocks?: readonly PromptBlock[] | null;
};

export type RunAiResult<T> = { runId: string; output: T; usage: AiUsage; model: string; costCents: number };

/** The one way a Content Program feature calls the model. */
/**
 * Free the keys dead runs still hold. A run left RUNNING past its lease
 * (function timeout, deploy mid-call) would hold its dedupeKey forever and
 * every later click for that script/topic/interview/call would get "already
 * running" — so it is expired. A QUEUE-owned run is left alone here: the queue
 * re-queues it (aiQueue.recoverStale), because a person asked for that draft.
 * A finished run whose caller died before releaseRunKey (holdDedupeKey) stays
 * SUCCEEDED — the model call did succeed — and only the key goes.
 */
export async function expireStaleRuns(now: Date = new Date()): Promise<void> {
  await prisma.programAiRun.updateMany({
    where: { status: "RUNNING", leaseUntil: { lt: now }, OR: [{ leaseBy: null }, { NOT: { leaseBy: { startsWith: QUEUE_LEASE_PREFIX } } }] },
    data: { status: "FAILED", error: "Lease expired — the run never finished (timed out or the server restarted).", errorAt: now, finishedAt: now, dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
  await prisma.programAiRun.updateMany({
    where: { status: "SUCCEEDED", dedupeKey: { not: null }, leaseUntil: { lt: now } },
    data: { dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
}

export async function runAiJson<T>(opts: RunAiOpts<T>): Promise<RunAiResult<T>> {
  if (opts.unattended && !(await isAutomationEnabled("ai_runs"))) throw new AutomationDisabledError();
  const claimed = opts.claimedRun ?? null;
  await assertQuota(opts.kind, opts.enrollmentId ?? null, claimed?.id ?? null, { offline: isOfflineRun(opts.requestedBy, opts.scope ?? null) });
  // Duplicate clicks: an active run with the same dedupeKey means "wait for
  // that one", not "start a second". Postgres enforces it (unique dedupeKey).
  let runId: string;
  const now = new Date();
  await expireStaleRuns(now);
  const base = {
    kind: opts.kind,
    enrollmentId: opts.enrollmentId ?? null,
    clientId: opts.clientId ?? null,
    scopeJson: opts.scope ? JSON.stringify(opts.scope) : null,
    inputRefsJson: opts.inputRefs ? JSON.stringify({ ...opts.inputRefs, promptHash: sha256(opts.system + "\n" + opts.prompt) }) : JSON.stringify({ promptHash: sha256(opts.system + "\n" + opts.prompt) }),
    promptKey: opts.promptKey,
    promptVersion: opts.promptVersion ?? GENERATION_POLICY_VERSION,
    model: opts.model ?? (opts.engine === "writer" ? WRITER_MODEL : null),
    policyVersionId: opts.policyVersionId ?? null,
    strategyVersionId: opts.strategyVersionId ?? null,
    status: "RUNNING",
    attempts: 1,
    requestedBy: opts.requestedBy,
    startedAt: now,
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    leaseBy: opts.requestedBy,
  };
  if (claimed) {
    // ADOPT the queued row (aiQueue.ts): it already holds the key and the
    // person's name; this records what the prompt was built from and renews
    // the lease from the moment the model is called. Only while the worker
    // still holds it — a row the queue took back is not ours to run.
    const prev = await prisma.programAiRun.findUnique({ where: { id: claimed.id }, select: { scopeJson: true } });
    let queuedScope: Record<string, unknown> = {};
    try { queuedScope = prev?.scopeJson ? (JSON.parse(prev.scopeJson) as Record<string, unknown>) : {}; } catch { queuedScope = {}; }
    const adopted = await prisma.programAiRun.updateMany({
      where: { id: claimed.id, status: "RUNNING", leaseBy: claimed.leaseBy },
      data: {
        kind: base.kind, enrollmentId: base.enrollmentId, clientId: base.clientId, scopeJson: JSON.stringify({ ...queuedScope, ...(opts.scope ?? {}) }),
        inputRefsJson: base.inputRefsJson, promptKey: base.promptKey, promptVersion: base.promptVersion, model: base.model, policyVersionId: base.policyVersionId, strategyVersionId: base.strategyVersionId,
        startedAt: now, leaseUntil: base.leaseUntil,
      },
    });
    if (adopted.count === 0) throw new LeaseLostError("This queued AI run was taken back by the queue before it reached the model — nothing was spent; the queue runs it again.");
    runId = claimed.id;
  } else {
    try {
      const row = await prisma.programAiRun.create({ data: { ...base, dedupeKey: opts.dedupeKey ?? null }, select: { id: true } });
      runId = row.id;
    } catch (e) {
      if (opts.dedupeKey && String(e).includes("Unique constraint")) {
        throw new Error("That generation is already running — give it a moment.");
      }
      throw e;
    }
  }
  // A queued run's writes are fenced on the worker's lease as well as on
  // RUNNING: the queue re-queues a run whose lease ran out (it does not fail
  // it), so "RUNNING" alone could be another worker's retry of the same row.
  const mine = claimed ? { leaseBy: claimed.leaseBy } : {};
  try {
    const { result, usage, model } = opts.engine === "writer"
      ? await aiStructuredWithUsage<T>({ system: opts.system, prompt: opts.prompt, schema: opts.schema, effort: opts.effort ?? "medium", maxTokens: opts.maxTokens, model: opts.model, timeoutMs: opts.timeoutMs, promptBlocks: opts.promptBlocks })
      : await aiJsonWithUsage<T>({ system: opts.system, prompt: opts.prompt, schema: opts.schema, maxTokens: opts.maxTokens, model: opts.model, timeoutMs: opts.timeoutMs });
    const output = opts.parse ? opts.parse(result) : result;
    const costCents = estimateCostCents(model, usage);
    const outputJson = JSON.stringify(output).slice(0, 200_000);
    // FENCED ON RUNNING (R04, Sep 28 2026). A run that outlived its lease was
    // marked FAILED above by the next caller, which freed the dedupe key and
    // paid for its own run. An unconditional write here flipped that FAILED
    // row back to SUCCEEDED, and the caller went on to apply this late output:
    // a second version on a script another run had already drafted.
    const done = await prisma.programAiRun.updateMany({
      where: { id: runId, status: "RUNNING", ...mine },
      data: {
        status: "SUCCEEDED", finishedAt: new Date(), model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costCents,
        outputJson,
        // The dedupe key only needs to hold while the run is active — or, with
        // holdDedupeKey, until the caller has written the output. That write
        // gets a fresh lease from the moment the model answered: counted from
        // the run's start, a slow answer left seconds for it (see claimRunWrite).
        ...(opts.holdDedupeKey ? { leaseUntil: new Date(Date.now() + LEASE_MS) } : { dedupeKey: null, leaseUntil: null, leaseBy: null }),
      },
    });
    if (done.count === 0) {
      // Keep what it cost and what it said on the FAILED row, then stop.
      await prisma.programAiRun.updateMany({
        where: { id: runId, status: "FAILED" },
        data: { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costCents, outputJson, error: "Completed after its lease expired — output kept here, not applied." },
      }).catch(() => {});
      throw new LeaseLostError();
    }
    return { runId, output, usage, model, costCents };
  } catch (e) {
    // The row already says what happened; the FAILED write below would only
    // overwrite that with this error's text.
    if (e instanceof LeaseLostError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const failed = { status: "FAILED", error: msg.slice(0, 2000), errorAt: new Date(), finishedAt: new Date(), leaseUntil: null, leaseBy: null, dedupeKey: null };
    if (claimed) await prisma.programAiRun.updateMany({ where: { id: runId, status: "RUNNING", ...mine }, data: failed }).catch(() => {});
    else await prisma.programAiRun.update({ where: { id: runId }, data: failed }).catch(() => {});
    throw e;
  }
}

/**
 * THE WRITE IS FENCED TOO (review, Sep 28). R04 fenced RUNNING → SUCCEEDED,
 * but a holdDedupeKey run sits SUCCEEDED, key held, until its caller writes
 * the output — and a caller that froze in that gap past the lease had its key
 * freed by the next caller's cleanup (runAiJson, above), which then drafted
 * the script itself. The frozen caller woke, found that script and added a
 * SECOND version to it: one script, two versions, both runs SUCCEEDED. Call
 * this right before writing a holdDedupeKey run's output: it proves the run
 * still holds its lease (the cleanup nulls leaseUntil when it frees a key) and
 * extends it for the write, or throws LeaseLostError — which the owed-script
 * sweep already counts as a lost race. The output stays on the run row.
 */
export async function claimRunWrite(runId: string): Promise<void> {
  const now = new Date();
  const r = await prisma.programAiRun.updateMany({
    where: { id: runId, status: "SUCCEEDED", leaseUntil: { gt: now } },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (r.count === 0) {
    throw new LeaseLostError("This AI run's output was ready, but its lease ran out before it was written and another run could have taken its place. Its output is kept on the run and was not used.");
  }
}

/** Free a held dedupe key (holdDedupeKey) once the run's output is written — or abandoned. */
export async function releaseRunKey(runId: string): Promise<void> {
  await prisma.programAiRun.updateMany({ where: { id: runId, status: { not: "RUNNING" } }, data: { dedupeKey: null, leaseUntil: null, leaseBy: null } }).catch(() => {});
}

/** Point a run at the record it produced, once that record exists. */
export async function setRunOutputRef(runId: string, outputRef: string): Promise<void> {
  await prisma.programAiRun.update({ where: { id: runId }, data: { outputRef } }).catch(() => {});
}

/** The human verdict on a run's output (spec §13 "disposition"). */
export async function setRunDisposition(runId: string | null | undefined, disposition: "ACCEPTED" | "EDITED" | "REJECTED" | "SUPERSEDED" | "NOT_APPLICABLE", by: string): Promise<void> {
  if (!runId) return;
  await prisma.programAiRun.update({ where: { id: runId }, data: { disposition, dispositionBy: by, dispositionAt: new Date() } }).catch(() => {});
}

export async function recentAiRuns(enrollmentId: string, take = 30) {
  return prisma.programAiRun.findMany({ where: { enrollmentId }, orderBy: { createdAt: "desc" }, take });
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// The generation policy version row. The policy itself is CODE
// (src/lib/contentPolicy); this row is its versioned, stamp-able identity so
// every bank, strategy draft and script can say which policy produced it. One
// ACTIVE row at a time; the first call mints version 1 from the code defaults
// (10 per pillar, max 15, three points, 30–50 s — Jordan's rulings).
// ---------------------------------------------------------------------------
export type ActivePolicy = { id: string; versionNo: number; topicsPerPillar: number; topicsPerPillarMax: number; recommendedPerSession: number | null };

export async function activePolicyVersion(): Promise<ActivePolicy> {
  const sel = { id: true, versionNo: true, topicsPerPillar: true, topicsPerPillarMax: true, recommendedPerSession: true } as const;
  const active = await prisma.programGenerationPolicyVersion.findFirst({ where: { status: "ACTIVE" }, orderBy: { versionNo: "desc" }, select: sel });
  if (active) return active;
  const latest = await prisma.programGenerationPolicyVersion.findFirst({ orderBy: { versionNo: "desc" }, select: { versionNo: true } });
  const versionNo = (latest?.versionNo ?? 0) + 1;
  try {
    return await prisma.programGenerationPolicyVersion.create({
      data: {
        versionNo,
        name: `Policy ${GENERATION_POLICY_VERSION}`,
        status: "ACTIVE",
        strategyTemplateJson: JSON.stringify(STRATEGY_TEMPLATE),
        referenceManifestRef: "scratchpad/portal-references/REFERENCE_MANIFEST.md (Sep 16 2026)",
        topicsPerPillar: GENERATION_POLICY.topicsPerPillar.default,
        topicsPerPillarMax: GENERATION_POLICY.topicsPerPillar.max,
        talkingPoints: GENERATION_POLICY.talkingPoints.count,
        pointRolesJson: JSON.stringify(GENERATION_POLICY.talkingPoints.roles),
        timingTargetMinSec: GENERATION_POLICY.timing.targetSec[0],
        timingTargetMaxSec: GENERATION_POLICY.timing.targetSec[1],
        wordRangeJson: JSON.stringify({ min: GENERATION_POLICY.timing.heuristicWords[0], max: GENERATION_POLICY.timing.heuristicWords[1] }),
        scriptFormatJson: JSON.stringify({ presentation: GENERATION_POLICY.canonicalPresentation }),
        creativeRulesJson: JSON.stringify({ hooks: GENERATION_POLICY.hooks, devices: GENERATION_POLICY.devices, overrides: GENERATION_POLICY.overrides }),
        rubricJson: JSON.stringify(GENERATION_POLICY.qualityDimensions),
        validatorsJson: JSON.stringify(["validateNewScript", "validateTopicBank", "validateStrategyStructure"]),
        promptsJson: JSON.stringify({ strategy: GENERATION_POLICY_VERSION, "topic-bank": GENERATION_POLICY_VERSION, script: GENERATION_POLICY_VERSION, "interview-follow-up": GENERATION_POLICY_VERSION, caption: GENERATION_POLICY_VERSION }),
        notes: policyRulesText().slice(0, 4000),
        contentHash: GENERATION_POLICY_HASH,
        createdBy: "code",
        activatedAt: new Date(),
        activatedBy: "code",
      },
      select: sel,
    });
  } catch {
    // Two first-callers raced on versionNo — the other one won; read it back.
    const again = await prisma.programGenerationPolicyVersion.findFirst({ where: { status: "ACTIVE" }, orderBy: { versionNo: "desc" }, select: sel });
    if (again) return again;
    throw new Error("Could not establish the active generation policy version.");
  }
}

/** Owner control: topics per pillar (10 by default, configurable to 15 — Jordan's ruling). */
export async function setTopicsPerPillar(n: number): Promise<ActivePolicy> {
  const cfg = GENERATION_POLICY.topicsPerPillar;
  if (!Number.isInteger(n) || n < cfg.min || n > cfg.max) throw new Error(`Topics per pillar must be ${cfg.min}–${cfg.max}.`);
  const p = await activePolicyVersion();
  await prisma.programGenerationPolicyVersion.update({ where: { id: p.id }, data: { topicsPerPillar: n } });
  return { ...p, topicsPerPillar: n };
}
