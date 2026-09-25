import "server-only";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { aiJsonWithUsage, type AiUsage } from "@/lib/integrations/ai";
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
  constructor(msg: string) {
    super(msg);
    this.name = "QuotaExceededError";
  }
}

export type AiRunKind =
  | "call_analysis" | "fact_extract" | "strategy_draft" | "topic_bank" | "topic_refresh" | "recommendation"
  | "interview_plan" | "script_draft" | "script_revise" | "creative_review" | "caption" | "transcript" | "script_match" | "profile_draft"
  | "import_split";

// Anthropic first-party rates, USD per million tokens (cached Sep 2026). A
// cost ESTIMATE for the ledger — the invoice is the truth; cache reads are
// billed at a tenth and cache writes at 1.25× of input.
const RATES_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
export function estimateCostCents(model: string, u: AiUsage): number {
  const r = RATES_PER_MILLION[model] ?? RATES_PER_MILLION["claude-sonnet-4-6"];
  const usd =
    (u.inputTokens * r.input + u.outputTokens * r.output + u.cacheReadTokens * r.input * 0.1 + u.cacheWriteTokens * r.input * 1.25) / 1_000_000;
  return Math.round(usd * 100);
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

async function assertQuota(kind: AiRunKind, enrollmentId: string | null): Promise<void> {
  const since = dayStart();
  const rows = await prisma.programAiQuota.findMany({ where: { period: "DAY", enabled: true } });
  const limitFor = (scope: string, ref: string, fallback: number) => {
    const row = rows.find((r) => r.scope === scope && r.scopeRef === ref);
    return row?.maxRuns ?? fallback;
  };
  const checks: { where: Record<string, unknown>; max: number; what: string }[] = [
    { where: {}, max: limitFor("GLOBAL", "", DEFAULT_QUOTA.globalPerDay), what: "the program-wide daily AI limit" },
    { where: { kind }, max: limitFor("KIND", kind, DEFAULT_QUOTA.kindPerDay), what: `the daily limit for ${kind} runs` },
  ];
  if (enrollmentId) checks.push({ where: { enrollmentId }, max: limitFor("ENROLLMENT", enrollmentId, DEFAULT_QUOTA.enrollmentPerDay), what: "this client's daily AI limit" });
  for (const c of checks) {
    const n = await prisma.programAiRun.count({ where: { ...c.where, startedAt: { gte: since }, status: { in: ["RUNNING", "SUCCEEDED", "FAILED"] } } });
    if (n >= c.max) throw new QuotaExceededError(`${c.what} (${c.max}/day) is reached — try again tomorrow or raise the quota.`);
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
  /** Called with the parsed output; its return value is stored as outputRef ("ContentScriptVersion:<id>"). */
  parse?: (out: T) => T;
};

export type RunAiResult<T> = { runId: string; output: T; usage: AiUsage; model: string; costCents: number };

/** The one way a Content Program feature calls the model. */
export async function runAiJson<T>(opts: RunAiOpts<T>): Promise<RunAiResult<T>> {
  if (opts.unattended && !(await isAutomationEnabled("ai_runs"))) throw new AutomationDisabledError();
  await assertQuota(opts.kind, opts.enrollmentId ?? null);
  // Duplicate clicks: an active run with the same dedupeKey means "wait for
  // that one", not "start a second". Postgres enforces it (unique dedupeKey).
  let runId: string;
  const now = new Date();
  // A run left RUNNING past its lease (function timeout, deploy mid-call) would
  // hold its dedupeKey forever and every later click for that script/topic/
  // interview/call would get "already running" — expire it first.
  await prisma.programAiRun.updateMany({
    where: { status: "RUNNING", leaseUntil: { lt: now } },
    data: { status: "FAILED", error: "Lease expired — the run never finished (timed out or the server restarted).", errorAt: now, finishedAt: now, dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
  // A finished run whose caller died before releaseRunKey (holdDedupeKey):
  // the model call succeeded, so the row stays SUCCEEDED — only the key goes.
  await prisma.programAiRun.updateMany({
    where: { status: "SUCCEEDED", dedupeKey: { not: null }, leaseUntil: { lt: now } },
    data: { dedupeKey: null, leaseUntil: null, leaseBy: null },
  }).catch(() => {});
  const base = {
    kind: opts.kind,
    enrollmentId: opts.enrollmentId ?? null,
    clientId: opts.clientId ?? null,
    scopeJson: opts.scope ? JSON.stringify(opts.scope) : null,
    inputRefsJson: opts.inputRefs ? JSON.stringify({ ...opts.inputRefs, promptHash: sha256(opts.system + "\n" + opts.prompt) }) : JSON.stringify({ promptHash: sha256(opts.system + "\n" + opts.prompt) }),
    promptKey: opts.promptKey,
    promptVersion: opts.promptVersion ?? GENERATION_POLICY_VERSION,
    model: opts.model ?? null,
    policyVersionId: opts.policyVersionId ?? null,
    strategyVersionId: opts.strategyVersionId ?? null,
    status: "RUNNING",
    attempts: 1,
    requestedBy: opts.requestedBy,
    startedAt: now,
    leaseUntil: new Date(now.getTime() + 10 * 60_000),
    leaseBy: opts.requestedBy,
  };
  try {
    const row = await prisma.programAiRun.create({ data: { ...base, dedupeKey: opts.dedupeKey ?? null }, select: { id: true } });
    runId = row.id;
  } catch (e) {
    if (opts.dedupeKey && String(e).includes("Unique constraint")) {
      throw new Error("That generation is already running — give it a moment.");
    }
    throw e;
  }
  try {
    const { result, usage, model } = await aiJsonWithUsage<T>({ system: opts.system, prompt: opts.prompt, schema: opts.schema, maxTokens: opts.maxTokens, model: opts.model });
    const output = opts.parse ? opts.parse(result) : result;
    const costCents = estimateCostCents(model, usage);
    await prisma.programAiRun.update({
      where: { id: runId },
      data: {
        status: "SUCCEEDED", finishedAt: new Date(), model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costCents,
        outputJson: JSON.stringify(output).slice(0, 200_000),
        // The dedupe key only needs to hold while the run is active — or, with
        // holdDedupeKey, until the caller has written the output.
        ...(opts.holdDedupeKey ? {} : { dedupeKey: null, leaseUntil: null, leaseBy: null }),
      },
    });
    return { runId, output, usage, model, costCents };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.programAiRun.update({
      where: { id: runId },
      data: { status: "FAILED", error: msg.slice(0, 2000), errorAt: new Date(), finishedAt: new Date(), leaseUntil: null, leaseBy: null, dedupeKey: null },
    }).catch(() => {});
    throw e;
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
// (10 per pillar, max 15, three points, 20–30 s — Jordan's rulings).
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
