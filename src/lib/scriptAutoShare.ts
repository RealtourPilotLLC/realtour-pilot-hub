import "server-only";
import { prisma } from "@/lib/prisma";
import { automationConfig, isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";
import { programReach, rolloutSweepClientIds } from "@/lib/programRollout";

// ---------------------------------------------------------------------------
// SHARE WITHOUT JORDAN'S INDIVIDUAL APPROVAL (6.5, unified handoff Sep 25 2026).
//
// §3 settles three SEPARATE controls:
//   1. script_drafting   — the hub drafts what a month owes (with ai_runs);
//   2. script_auto_share — THIS: a clean, sweep-drafted script is approved and
//                          released to the client's portal without a person;
//   3. script_share_email — the client is emailed when a script is shared.
// Each is its own switch, and a missing row is OFF. #2 is OFF until Jordan
// turns it on: while it is off he approves every script before a client sees
// it. Turning it on changes only who presses the button — the approval and the
// release are still the same two ledger rows (scriptShare.shareApprovedScript,
// actor "auto-share"), and the email still happens only if #3 is on.
//
// WHAT QUALIFIES (autoShareEligible). Everything must hold, or it waits for a
// person and the reason is recorded in the preview:
//   · the script's CURRENT version, still DRAFT or INTERNAL_REVIEW, on a live
//     (non-historical) script;
//   · drafted by the unattended sweep (source AI, created by "cron", with a
//     model run) — never a hand edit, a revision or a client-requested change;
//   · no blocking format finding, and (config.requireInTarget, default on) no
//     length warning: a script clearly under 30 s or well over a minute
//     (the validator's soft timing warning) waits for Jordan;
//   · drafted from the strategy version that is STILL the approved one;
//   · a topic in the month's allowance (R01's allowanceOrder), not an extra;
//   · an ACTIVE program with portal access, and no open change request from
//     the client on this script;
//   · older than config.holdMinutes (default 120), so Jordan can step in;
//   · (config.testClientsOnly, default on) a TEST client — the launch gate;
//   · (R03, Sep 28 2026) a client the PROGRAM ROLLOUT reaches for this op
//     (script_auto_share), with testClientsOnly as the feature's own
//     narrowing lock inside it — lifting the lock now means "the rollout",
//     never "every real client" — and a draft written SINCE the client entered
//     the rollout: joining the pilot never auto-shares a backlog of older drafts.
// Idempotent by construction: shareApprovedScript approves once, releases
// once, queues once.
// ---------------------------------------------------------------------------

export const AUTO_SHARE_KEY = "script_auto_share" as const;
export const AUTO_SHARE_ACTOR = { email: "auto-share", appUserId: null } as const;
export const AUTO_SHARE_DEFAULTS = { holdMinutes: 120, requireInTarget: true, testClientsOnly: true, max: 10 };
export type AutoShareConfig = typeof AUTO_SHARE_DEFAULTS;

export type AutoShareVerdict = { ok: boolean; reasons: string[] };

/** May this version be shared without a person? Pure read. */
export async function autoShareEligible(versionId: string, opts: { now?: Date; config?: Partial<AutoShareConfig> } = {}): Promise<AutoShareVerdict> {
  const now = opts.now ?? new Date();
  const cfg = { ...AUTO_SHARE_DEFAULTS, ...(opts.config ?? {}) };
  const reasons: string[] = [];
  const v = await prisma.contentScriptVersion.findUnique({
    where: { id: versionId },
    select: { id: true, scriptId: true, enrollmentId: true, clientId: true, status: true, source: true, createdBy: true, aiRunId: true, validationJson: true, strategyVersionId: true, createdAt: true },
  });
  if (!v) return { ok: false, reasons: ["version not found"] };
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { historical: true, currentVersionId: true, topicId: true, monthId: true, sharedVersionId: true } });
  if (!s) return { ok: false, reasons: ["script not found"] };
  if (s.historical) reasons.push("a historical import");
  if (s.currentVersionId !== v.id) reasons.push("not the script's current version");
  if (v.status !== "DRAFT" && v.status !== "INTERNAL_REVIEW") reasons.push(`already ${v.status.toLowerCase()}`);
  if (v.source !== "AI" || v.createdBy !== "cron" || !v.aiRunId) reasons.push("not drafted by the unattended sweep (a person's edit or request waits for a person)");

  // The stored format check.
  let findings: { code?: string; severity?: string }[] = [];
  try { findings = v.validationJson ? ((JSON.parse(v.validationJson) as { findings?: typeof findings }).findings ?? []) : []; } catch { reasons.push("its format check could not be read"); }
  if (!v.validationJson) reasons.push("no format check on record");
  if (findings.some((f) => f.severity === "block")) reasons.push("a blocking format finding");
  if (cfg.requireInTarget && findings.some((f) => f.code === "timing.out-of-range")) reasons.push("a length warning (clearly under 30 seconds or well over a minute)");

  // The strategy it was drafted from is still the approved one.
  const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: v.enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { id: true } });
  if (!approved || v.strategyVersionId !== approved.id) reasons.push("drafted from a strategy that is no longer the approved one");

  // The topic is in the month's allowance.
  if (!s.topicId || !s.monthId) reasons.push("not tied to a topic on a month's plan");
  else {
    const allowance = await import("@/lib/planningFacts").then((m) => m.monthAllowances([s.monthId!])).then((mm) => mm.get(s.monthId!) ?? null).catch(() => null);
    const slot = allowance?.slots.get(s.topicId) ?? null;
    if (allowance ? slot !== "IN" : (await prisma.contentTopicSelection.count({ where: { topicId: s.topicId, monthId: s.monthId, status: { in: ["SELECTED", "RECONCILED", "CARRIED"] }, overflow: false } })) === 0) reasons.push("an extra beyond the month's allowance");
  }

  const [enrollment, openRequests, returned] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: v.enrollmentId }, select: { status: true, accessRevokedAt: true } }),
    prisma.scriptSuggestion.count({ where: { scriptId: v.scriptId, status: "OPEN" } }),
    prisma.contentScriptRelease.count({ where: { scriptId: v.scriptId, action: "RETURN_TO_QUEUE" } }),
  ]);
  if (enrollment?.status !== "ACTIVE") reasons.push(`the program is ${enrollment?.status?.toLowerCase() ?? "missing"}`);
  if (enrollment?.accessRevokedAt) reasons.push("portal access is revoked");
  if (openRequests > 0) reasons.push("the client has an open change request on this script");
  // returnScriptToQueue hands the SAME cron version back to INTERNAL_REVIEW,
  // still current and long past its hold — without this the next hourly run
  // re-approved and re-shared the script a person had just pulled back.
  if (returned > 0) reasons.push("a person returned this script to the queue — it waits for a person");
  if (now.getTime() - v.createdAt.getTime() < cfg.holdMinutes * 60_000) reasons.push(`inside the ${cfg.holdMinutes}-minute hold`);
  // R03: one decision — the lock and the scope (programReach re-reads the
  // client row by id, so a real row renamed TEST is real here).
  const reach = await programReach("script_auto_share", v.clientId, { now, featureTestOnly: cfg.testClientsOnly });
  if (!reach.ok) reasons.push(reach.code === "feature_test_only" ? "testClientsOnly: only TEST clients until launch is authorised" : `not in the program rollout: ${reach.reason}`);
  else if (reach.since && v.createdAt < reach.since) reasons.push("drafted before this client joined the rollout");
  return { ok: reasons.length === 0, reasons };
}

/**
 * One candidate's result. `wouldShare` is the DRY RUN's "the live run would
 * approve and release this one" (review fix, Sep 28 2026): the dry run used to
 * say only { shared: false, reasons: ["would share (dry run)"] }, and the
 * owner's "What would go out now?" read shared:false as "no" — every draft the
 * next hourly run would release showed as not going out.
 */
export type AutoShareOutcome = { versionId: string; scriptId: string; title: string; shared: boolean; wouldShare?: true; reasons: string[]; email?: string; error?: string };

/**
 * HOURLY, after the drafting sweep. OFF (skipped, nothing read beyond the
 * switch) unless `script_auto_share` is on. `dryRun` answers "what would it
 * share?" for a preview without writing — it needs no switch.
 */
export async function sweepAutoShare(opts: { now?: Date; max?: number; dryRun?: boolean } = {}): Promise<{ skipped: string } | { considered: number; shared: number; waiting: number; outcomes: AutoShareOutcome[] }> {
  const now = opts.now ?? new Date();
  let cfg: AutoShareConfig;
  if (opts.dryRun) {
    cfg = (await automationConfig<AutoShareConfig>(AUTO_SHARE_KEY, AUTO_SHARE_DEFAULTS)) ?? AUTO_SHARE_DEFAULTS;
  } else {
    if (!(await isAutomationEnabled(AUTO_SHARE_KEY))) return { skipped: `${AUTO_SHARE_KEY} is off` };
    cfg = (await automationConfig<AutoShareConfig>(AUTO_SHARE_KEY, AUTO_SHARE_DEFAULTS)) ?? AUTO_SHARE_DEFAULTS;
  }
  const max = Math.max(1, Math.min(50, Number(opts.max ?? cfg.max) || 10));
  // THE WINDOW IS FILTERED AT THE READ (batch-2 review, Sep 25 2026). It was
  // the oldest max×4 cron versions, full stop — and rows that can never
  // qualify stay in that set for good: a cron v1 a person replaced (nothing
  // retires it; it stays DRAFT and is never current again), every real
  // client's draft while testClientsOnly holds, a script a person pulled back.
  // Forty of those and a TEST client's eligible draft was never even looked
  // at. So the read takes only CURRENT versions of live scripts, only TEST
  // clients' while the launch gate holds, never a returned script; what is
  // left is checked in full by autoShareEligible as before.
  // R03 (Sep 28 2026): TEST clients plus the real clients the rollout admits
  // for script_auto_share (null = everyone: mode ALL with the lock lifted).
  const testClientIds = await rolloutSweepClientIds("script_auto_share", { now, featureTestOnly: cfg.testClientsOnly });
  const liveScripts = testClientIds && !testClientIds.length ? [] : await prisma.contentScript.findMany({
    where: { historical: false, currentVersionId: { not: null }, ...(testClientIds ? { clientId: { in: testClientIds } } : {}) },
    select: { id: true, currentVersionId: true },
  });
  const returned = new Set(
    liveScripts.length ? (await prisma.contentScriptRelease.findMany({ where: { scriptId: { in: liveScripts.map((x) => x.id) }, action: "RETURN_TO_QUEUE" }, select: { scriptId: true } })).map((r) => r.scriptId) : [],
  );
  const currentIds = liveScripts.filter((x) => !returned.has(x.id)).map((x) => x.currentVersionId!);
  const candidates = currentIds.length ? await prisma.contentScriptVersion.findMany({
    where: { id: { in: currentIds }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, source: "AI", createdBy: "cron", createdAt: { lte: new Date(now.getTime() - cfg.holdMinutes * 60_000) } },
    orderBy: { createdAt: "asc" },
    take: max * 4,
    select: { id: true, scriptId: true, title: true },
  }) : [];
  const outcomes: AutoShareOutcome[] = [];
  let shared = 0;
  let wouldShare = 0;
  let lastError: string | null = null;
  for (const c of candidates) {
    // The dry run counts what it WOULD share against the same cap, so it names
    // exactly the drafts one live run takes — not every eligible one.
    if (shared + wouldShare >= max) break;
    const verdict = await autoShareEligible(c.id, { now, config: cfg });
    if (!verdict.ok) { outcomes.push({ versionId: c.id, scriptId: c.scriptId, title: c.title, shared: false, reasons: verdict.reasons }); continue; }
    if (opts.dryRun) { wouldShare++; outcomes.push({ versionId: c.id, scriptId: c.scriptId, title: c.title, shared: false, wouldShare: true, reasons: ["would share (dry run)"] }); continue; }
    try {
      const { shareApprovedScript } = await import("@/lib/scriptShare");
      const r = await shareApprovedScript(c.id, AUTO_SHARE_ACTOR, { note: "Approved and shared automatically (script_auto_share): clean sweep draft after the hold." });
      shared++;
      outcomes.push({ versionId: c.id, scriptId: c.scriptId, title: c.title, shared: true, reasons: [], email: r.email });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      outcomes.push({ versionId: c.id, scriptId: c.scriptId, title: c.title, shared: false, reasons: [], error: lastError.slice(0, 300) });
    }
  }
  if (!opts.dryRun) await recordAutomationRun(AUTO_SHARE_KEY, lastError).catch(() => {});
  return { considered: candidates.length, shared, waiting: outcomes.filter((o) => !o.shared).length, outcomes: outcomes.slice(0, 20) };
}
