import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson } from "@/lib/aiRuns";
import { timeoutBefore } from "@/lib/integrations/ai";
import { buildScriptJudgePrompt, judgeCriteriaFor, JUDGE_CRITERIA_TEXT, type JudgeCriterion, type ScriptAngle } from "@/lib/contentPolicy";
import { MAX_FIX_ROUNDS, readJudge, readAngle, attemptScoreOf, type JudgeRecord, type JudgeCriterionResult } from "@/lib/scriptJudgeRecord";
import { pointsFromJson, createScriptVersion, makeVersionCurrent, type VersionParts } from "@/lib/contentScripts";
import { bestAttempt, isBetterAttempt, mustFixFailures, type AttemptScore } from "@/lib/scriptWriter/rules";

// ---------------------------------------------------------------------------
// THE AUTOMATIC CHECK AND FIX (Oct 14 2026). Jordan: "I want this to be as
// hands off as possible. I want AI to fix something if it didn't pass
// judgement, I don't want to deal with that. Right now we review all scripts
// before they are sent."
//
// After every AI draft of a monthly personal-brand script (the unattended
// sweep and a person's "Draft script" alike):
//   1. the deterministic checks already ran when the version was written
//      (validateNewScript: format, the 110-word ceiling, hook length, a
//      re-hook that repeats the hook, stock phrases, a skit's real-client
//      claim, dashes);
//   2. ONE judge call (kind script_judge, ai_runs-gated when unattended,
//      1200 output tokens) scores the script pass/fail with one-line reasons:
//      the hook pulls a real lever, the re-hook escalates, the build up earns
//      it, the payoff answers the hook, the close satisfies, it sounds like
//      this client, nothing invented, and for a skit: funny, safe, solo;
//   3. on a fail, the SAME revise path (reviseScript, the script's original
//      source) runs with the judge's notes as the instruction, and the new
//      version is judged again. Two fix rounds at most. Still failing: the
//      better attempt is kept and marked flagged, which sorts it first in the
//      review queue (the card says nothing about it: Oct 23 2026).
//
// NEVER A WORSE VERSION (Oct 23 2026). Jordan: "I don't need to see that it
// needs fixes; I just need it to be fixed." Each fix round (and the new
// writer's cap trim) is written into the history as a CANDIDATE: the
// script's current version does not move. The candidate is judged, then
// becomes current only when it is better (rules.isBetterAttempt: fewer
// must-fix failures, then the craft total, then the length rule). Otherwise
// it is set_aside, the version it was fixing stays current with the round
// counted, and the next round starts from that better version again. When the
// rounds run out still failing, the best version is the current one, flagged
// quietly. Every round stays in the history.
// Missing facts are never "fixed": the judge is told a gap is not a failure.
// Approval and sharing are untouched: every version lands in Jordan's review
// queue exactly as before. A failed judge call never blocks a draft: it
// stands, labelled "not checked".
//
// TIME. A model call is 20 to 60 seconds and the queue worker and the cron
// both run against a clock, so each step starts only with time to finish it
// (the caller's deadline); whatever is left (state pending or fixing) is
// picked up by sweepScriptChecks on the 15-minute AI cron.
// ---------------------------------------------------------------------------

/** A judge call is short (1200 output tokens); a fix round is a full script call. */
export const JUDGE_MIN_START_MS = 30_000;
export const FIX_MIN_START_MS = 90_000;
/** When the caller names no deadline (a person's click, a drill): this long from the start. */
const DEFAULT_BUDGET_MS = 150_000;
/** A judge call that failed is retried by the sweep at most this many times in all. */
const MAX_JUDGE_ATTEMPTS = 3;

type VersionRow = NonNullable<Awaited<ReturnType<typeof prisma.contentScriptVersion.findUnique>>>;

/** Write the judge record into the version's validationJson, keeping everything else on it. */
async function writeJudge(versionId: string, judge: JudgeRecord): Promise<void> {
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId }, select: { validationJson: true } });
  let bag: Record<string, unknown> = {};
  try { bag = v?.validationJson ? (JSON.parse(v.validationJson) as Record<string, unknown>) : {}; } catch { bag = {}; }
  await prisma.contentScriptVersion.update({ where: { id: versionId }, data: { validationJson: JSON.stringify({ ...bag, judge }) } });
}

type JudgeOut = { criteria?: { key?: string; pass?: boolean; note?: string }[]; fixInstruction?: string | null };

/** One judge call on one version. Throws when the model's answer is unusable (the caller records "not checked"). */
export async function judgeVersion(versionId: string, opts: { requestedBy: string; unattended: boolean; /** Oct 21 2026 (audit H1): a sweep's clock (ms epoch); the model call ends by it. */ deadline?: number | null }): Promise<{ criteria: JudgeCriterionResult[]; failed: JudgeCriterionResult[]; fixInstruction: string | null; runId: string }> {
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("Version not found.");
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId } });
  if (!s) throw new Error("Script not found.");
  const { buildClientContext, scriptSourceFor } = await import("@/lib/contentGeneration");
  const built = await buildClientContext(s.enrollmentId, { monthId: s.monthId, excludeScriptId: s.id });
  // Oct 22 2026: judged as the format it was WRITTEN in (the version's stamp,
  // or its speaker labels); an older version with neither follows its topic,
  // else the account's default, as its draft did.
  const { versionFormatOf, formatForWrite, topicFormatOf, asVideoStyle } = await import("@/lib/contentPolicy/videoFormat");
  const topicOwn = s.topicId ? topicFormatOf((await prisma.contentTopic.findUnique({ where: { id: s.topicId }, select: { scoresJson: true } }))?.scoresJson) : null;
  built.ctx.videoFormat = versionFormatOf(v) ?? formatForWrite({ topicFormat: topicOwn, style: asVideoStyle(built.ctx.videoStyle) });
  const skit = built.ctx.videoFormat === "SKIT";
  const { source } = await scriptSourceFor(s, v);
  let gaps: { kind: string; text: string }[] = [];
  try { gaps = v.gapsJson ? (JSON.parse(v.gapsJson) as { kind: string; text: string }[]) : []; } catch { gaps = []; }
  const bundle = buildScriptJudgePrompt(built.ctx, source, { body: v.body, angle: readAngle(v.validationJson) as Partial<ScriptAngle> | null, gaps });
  const run = await runAiJson<JudgeOut>({
    kind: "script_judge", enrollmentId: s.enrollmentId, clientId: s.clientId, scope: { scriptId: s.id, versionId }, inputRefs: { ...built.inputRefs, sourcePath: source.path },
    promptKey: "script-judge", promptVersion: "judge.v1", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId,
    requestedBy: opts.requestedBy, unattended: opts.unattended, dedupeKey: `judge:${versionId}`,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 1200, timeoutMs: timeoutBefore(opts.deadline, 1200),
  });
  const keys = judgeCriteriaFor(skit);
  const got = Array.isArray(run.output?.criteria) ? run.output.criteria : [];
  const criteria: JudgeCriterionResult[] = [];
  for (const k of keys) {
    const c = got.find((x) => x?.key === k);
    if (!c || typeof c.pass !== "boolean") continue;
    criteria.push({ key: k, pass: c.pass, note: String(c.note ?? "").replace(/\s+/g, " ").trim().slice(0, 240) });
  }
  // An answer that scored fewer than half the criteria is not a judgement.
  if (criteria.length < Math.ceil(keys.length / 2)) throw new Error("The judge's answer did not score the script.");
  const failed = criteria.filter((c) => !c.pass);
  const fix = typeof run.output?.fixInstruction === "string" ? run.output.fixInstruction.trim().slice(0, 1200) : "";
  return { criteria, failed, fixInstruction: failed.length ? fix || null : null, runId: run.runId };
}

const issueLine = (c: JudgeCriterionResult) => `${c.key}: ${c.note || JUDGE_CRITERIA_TEXT[c.key as JudgeCriterion] || "did not pass"}`;

/** The instruction a fix round sends: the judge's own, else its notes; always "keep what passed, invent nothing". */
function fixInstructionFrom(j: JudgeRecord): string {
  const notes = j.issues.length ? `What did not pass:\n${j.issues.map((i) => `- ${i}`).join("\n")}` : "";
  return [
    "The automatic check found problems with this version. Fix only these, and keep every line that passed word for word where possible.",
    j.fixInstruction ? `Fix: ${j.fixInstruction}` : "",
    notes,
    "Use only the sources. Anything the sources do not support stays a gap: never invent a story, number, result or credential to fix a problem.",
  ].filter(Boolean).join("\n");
}

/** A version's parts, to copy an earlier attempt forward unchanged. */
function partsOf(v: VersionRow): VersionParts {
  const arr = (j: string | null) => { try { return j ? (JSON.parse(j) as string[]) : undefined; } catch { return undefined; } };
  let dims: Record<string, string> | null = null;
  try { dims = v.dimensionsCheckJson ? (JSON.parse(v.dimensionsCheckJson) as Record<string, string>) : null; } catch { dims = null; }
  return {
    title: v.title, categoryLabel: v.categoryLabel, pillarId: v.pillarId, secondaryPillarId: v.secondaryPillarId,
    hook: v.hook, points: pointsFromJson(v.pointsJson), close: v.close, captionCta: v.captionCta,
    filmingNotes: v.filmingNotes, creativeDirection: v.creativeDirection, productionNotes: v.productionNotes ? v.productionNotes.split("\n") : undefined, goal: v.goal,
    alternateHooks: arr(v.alternateHooksJson), speakerLabels: arr(v.speakerLabelsJson), sourceExcerpts: arr(v.sourceExcerptsJson), dimensionsCheck: dims, timingNote: v.timingNote,
  };
}

/**
 * Still failing after the last round: the best attempt stays current. The
 * attempts are this auto-check's chain (the current version and the versions
 * it was fixed from, each with a review by the same reviewer), compared by
 * rules.isBetterAttempt: fewer must-fix failures, then the craft total, then
 * the length rule; a tie keeps the current one.
 *
 * Since Oct 23 2026 a fix round only becomes current when it is better, so the
 * current version is already the best of its chain and this only marks it
 * flagged (quietly: the card shows no warning). A chain from before that day
 * may have a better EARLIER attempt: that version becomes the current one
 * again (contentScripts.makeVersionCurrent, nothing copied or deleted), and
 * the worse one is set aside in the history.
 */
async function finishFlagged(current: VersionRow, record: JudgeRecord, requestedBy: string): Promise<string> {
  void requestedBy;
  const chain: { v: VersionRow; j: JudgeRecord }[] = [{ v: current, j: record }];
  let cursor = current;
  // v2.5: room for the new writer's third fix round and its trims (the walk still stops at the draft).
  for (let i = 0; i < MAX_FIX_ROUNDS + 4 && cursor.basedOnVersionId; i++) {
    const prev = await prisma.contentScriptVersion.findUnique({ where: { id: cursor.basedOnVersionId } });
    const pj = prev ? readJudge(prev.validationJson) : null;
    if (!prev || !pj || !pj.criteria.length) break;
    // Only versions the same reviewer judged are compared (the new writer's review and the old judge score differently).
    if ((pj.writer === 2) !== (record.writer === 2)) break;
    chain.push({ v: prev, j: pj });
    // The new writer's trim pass keeps its round count: walk past it to the draft.
    if (pj.fixRounds === 0 && !pj.trimmed) break;
    cursor = prev;
  }
  const writerChain = record.writer === 2;
  const story = writerChain ? (await (await import("@/lib/scriptWriter/pipeline")).latestWriterRecord(current.scriptId, current.id))?.brief.videoType === "story" : false;
  const NONE: AttemptScore = { mustFix: Number.MAX_SAFE_INTEGER, craft: null, words: Number.MAX_SAFE_INTEGER };
  const best = chain[bestAttempt(chain.map((x) => attemptScoreOf(x.j, x.v.spokenWordCount, story) ?? NONE))] ?? chain[0];
  if (best.v.id === current.id) {
    await writeJudge(current.id, { ...record, state: "flagged" });
    return current.id;
  }
  // An earlier attempt is better: it is the current version again, carrying the rounds spent (a person's change in between wins).
  const moved = await makeVersionCurrent(current.scriptId, best.v.id, { expectCurrentId: current.id });
  if (!moved) {
    await writeJudge(current.id, { ...record, state: "flagged" });
    return current.id;
  }
  await writeJudge(best.v.id, { ...best.j, state: "flagged", fixRounds: Math.max(best.j.fixRounds, record.fixRounds), trimmed: !!(best.j.trimmed || record.trimmed), keptVersionNo: best.v.versionNo });
  await writeJudge(current.id, { ...record, state: "set_aside", keptInstead: best.v.versionNo });
  return best.v.id;
}

/**
 * The candidate round still owed a review for `parentId`, or null (Oct 23
 * 2026). The newest one: an earlier candidate of the same parent was settled
 * before the next round ran.
 */
async function owedCandidate(scriptId: string, parentId: string): Promise<{ v: VersionRow; j: JudgeRecord } | null> {
  const rows = await prisma.contentScriptVersion.findMany({
    where: { scriptId, basedOnVersionId: parentId, validationJson: { contains: `"candidateOf":"${parentId}"` } },
    orderBy: { versionNo: "desc" }, take: 3,
  });
  for (const v of rows) {
    const j = readJudge(v.validationJson);
    if (j?.candidateOf === parentId && (j.state === "pending" || j.state === "not_checked")) return { v, j };
    if (j?.candidateOf === parentId) return null;
  }
  return null;
}

/** Is the reviewed candidate better than the version it was fixing? A parent with no review to compare loses; a candidate with none never wins. */
function candidateWins(cand: { v: VersionRow; j: JudgeRecord }, parent: { v: VersionRow; j: JudgeRecord }, story: boolean): boolean {
  const c = attemptScoreOf(cand.j, cand.v.spokenWordCount, story);
  if (!c) return false;
  const p = attemptScoreOf(parent.j, parent.v.spokenWordCount, story);
  return !p || isBetterAttempt(c, p);
}

/** Set a candidate aside (kept in the history, never current) and give its parent the round it spent. */
async function setAside(cand: { v: VersionRow; j: JudgeRecord }, parent: { v: VersionRow; j: JudgeRecord }, why?: string): Promise<JudgeRecord> {
  await writeJudge(cand.v.id, { ...cand.j, state: "set_aside", keptInstead: parent.v.versionNo, ...(why ? { error: why } : {}) });
  return { ...parent.j, fixRounds: Math.max(parent.j.fixRounds, cand.j.fixRounds), trimmed: !!(parent.j.trimmed || cand.j.trimmed), aimTrimmed: !!(parent.j.aimTrimmed || cand.j.aimTrimmed) };
}

export type AutoCheckResult = {
  state: JudgeRecord["state"] | "skipped"; fixRounds: number; versionId: string | null; reason?: string;
  /** Oct 22 2026: a QuotaExceededError's cap. "client" = only this client's daily cap is spent; the sweep moves on to the next client. */
  quota?: "client" | "program";
};

/** The cap a QuotaExceededError names ("program" when unreadable, so a sweep stops as it always did). */
function quotaOf(e: unknown): "client" | "program" {
  return (e as { scope?: string } | null)?.scope === "client" ? "client" : "program";
}

/**
 * THE TRIM THAT LOST SUBSTANCE IS UNDONE (Oct 22 2026, v2.1). Jordan: "aim for
 * 55 - 85 words without making it dry, or incomplete". When the one trim pass
 * toward WRITER_LENGTH.trimTo (automatic, or a person's "Fix with AI") breaks a must-fix
 * check other than length (Enough substance, when a must-keep point went),
 * the version it was trimmed from is copied forward as the newest version,
 * with its review and a note saying why; the trimmed attempt stays in the
 * trail. "Longer than the 55 to 85 aim" stays on it as advice. v2.3: when the
 * kept version says the very line the trim's review failed on (the same close,
 * the same hook), it is copied forward FLAGGED, with that check failing on it.
 */
async function restoreBeforeTrim(current: VersionRow, record: JudgeRecord, requestedBy: string): Promise<{ versionId: string; state: JudgeRecord["state"] }> {
  const from = record.aimTrimOf ? await prisma.contentScriptVersion.findUnique({ where: { id: record.aimTrimOf } }) : null;
  if (!from || from.scriptId !== current.scriptId) {
    // Nothing to go back to: the trimmed version stands, flagged for a person.
    await writeJudge(current.id, { ...record, state: "flagged" });
    return { versionId: current.id, state: "flagged" };
  }
  const { keptLongerNote, carryConflicts, partsOfVersion, trimFailWhy } = await import("@/lib/scriptWriter/pipeline");
  // v2.3: the close is must-fix now, so a trim can be undone for more than a lost must-keep point; say which.
  const trimFails = (record.checks ?? []).filter((c) => !c.pass && c.level === "must-fix");
  const why = trimFailWhy(trimFails);
  await writeJudge(current.id, { ...record, state: "flagged", error: `This trim ${why}; v${from.versionNo} is kept.` });
  const s = await prisma.contentScript.findUnique({ where: { id: current.scriptId } });
  if (!s) return { versionId: current.id, state: "flagged" };
  const { keptLongerConflicts, WRITER_LENGTH } = await import("@/lib/scriptWriter/rules");
  let bag: Record<string, unknown> = {};
  try { bag = from.validationJson ? (JSON.parse(from.validationJson) as Record<string, unknown>) : {}; } catch { bag = {}; }
  let gaps: never[] | null = null;
  try { gaps = from.gapsJson ? JSON.parse(from.gapsJson) : null; } catch { gaps = null; }
  const fj = readJudge(from.validationJson);
  // v2.3: the kept version may not say the line the trim's review failed on (the same close, the same hook): then it is flagged.
  const conflicts = keptLongerConflicts({ parts: partsOfVersion(current), checks: record.checks ?? [] }, partsOfVersion(from));
  // Its review as it stood before the trim was asked for ("trimming" meant: passed, then trimmed).
  const settled: JudgeRecord["state"] | null = !fj ? null
    : conflicts.length ? "flagged"
    : fj.state === "passed" || fj.state === "flagged" || fj.state === "not_checked" ? fj.state
    : (fj.checks ?? []).some((c) => !c.pass && c.level === "must-fix") ? "flagged" : "passed";
  const keptChecks = fj && conflicts.length ? carryConflicts(fj.checks ?? [], record.checks ?? [], conflicts) : fj?.checks;
  const note = keptLongerNote(`v${from.versionNo}`, from.spokenWordCount ?? 0, conflicts, trimFails);
  // A plain variable: the version's bag carries the note beside the usual keys.
  const validation = {
    ...bag, ok: bag.ok !== false, findings: (bag.findings as never[]) ?? [], angle: bag.angle ?? null,
    ...(fj && settled ? { judge: { ...fj, state: settled, aimTrimmed: true, aimTrimOf: null, trimKind: undefined, keptVersionNo: from.versionNo, ...(conflicts.length ? { checks: keptChecks, error: note } : {}) } } : {}),
    lengthNote: note,
  };
  const r = await createScriptVersion({
    scriptId: s.id, enrollmentId: s.enrollmentId, monthId: s.monthId, topicId: s.topicId, parts: partsOf(from), source: "AI", createdBy: requestedBy, status: "INTERNAL_REVIEW",
    basedOnVersionId: current.id, interviewId: s.interviewId, callRecordId: s.callRecordId, strategyVersionId: from.strategyVersionId, policyVersionId: from.policyVersionId, aiRunId: from.aiRunId,
    validation, gaps, changeSummary: `Creative review: kept v${from.versionNo}; the trim toward ${WRITER_LENGTH.trimTo[0]} to ${WRITER_LENGTH.trimTo[1]} words ${why}.${conflicts.length ? ` Flagged: the trim's review failed a line v${from.versionNo} says too.` : ""}`,
  });
  return { versionId: r.versionId, state: settled ?? "flagged" };
}

/**
 * ONE STEP OF THE NEW WRITER'S REVIEW LOOP (Oct 22 2026, src/lib/scriptWriter).
 *
 *   pending / not_checked → the independent creative review (12 checks, the craft block + the
 *                           code's hard numbers). Then, by nextWriterStep:
 *                           passed; or the trim pass when only the length
 *                           fails; or a fix round (two at most); or, still over
 *                           the 110-word cap, the trim pass; or FLAGGED (the
 *                           better attempt kept, sorted first in the queue).
 *   fixing                → a fix round from the review's notes (it trims too
 *                           when over the cap), judged again.
 *   trimming              → the trim pass, judged again.
 *
 * A script already shared with the client is never changed here: no review,
 * no fix and no trim run on it (the shared version stays exactly what the
 * client saw; this draft waits for a person).
 */
async function writerReviewStep(
  scriptId: string, v: VersionRow, j: JudgeRecord, shared: boolean,
  o: { requestedBy: string; unattended: boolean; deadline: number | null; timeFor: (ms: number) => boolean },
): Promise<AutoCheckResult | "continue"> {
  const w = await import("@/lib/scriptWriter/pipeline");
  const { trimInstruction } = await import("@/lib/scriptWriter/rules");
  const stay = (reason: string): AutoCheckResult => ({ state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason });
  if (shared) {
    if (j.state === "pending" || j.state === "fixing" || j.state === "trimming") await writeJudge(v.id, { ...j, state: "not_checked", attempts: MAX_JUDGE_ATTEMPTS, error: "This script was already shared with the client, so the automatic review and fixes do not run on it." });
    return { state: "skipped", fixRounds: j.fixRounds, versionId: v.id, reason: "already shared with the client" };
  }
  const pausedOrRefused = (e: unknown): AutoCheckResult | null => {
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : "";
    if (/already running/i.test(msg)) return stay(j.state === "pending" || j.state === "not_checked" ? "judged elsewhere" : "a revision is running");
    if (name === "AutomationDisabledError") return stay(name);
    if (name === "QuotaExceededError") return { ...stay(name), quota: quotaOf(e) };
    if (name === "WriterPausedError") return stay("out of time");
    return null;
  };

  // v2.4 (the length fix): the writer's own draft over trimAbove is trimmed toward the aim BEFORE its first
  // review (Sonnet drafts at 87 words on average; the trim used to wait for a passing review that never came).
  // A told personal story is not: it may use up to the cap.
  if (j.state === "pending" && !j.fixRounds && !j.trimmed && !j.aimTrimmed && !j.aimTrimOf && !(j.checks ?? []).length) {
    const rec = await w.latestWriterRecord(scriptId, v.id);
    const words = v.spokenWordCount ?? 0;
    if (rec && w.nextWriterStep({ reviewed: false, mustFails: [], words, fixRounds: 0, trimmed: false, story: rec.brief.videoType === "story" }) === "aim-trim") {
      await writeJudge(v.id, { ...j, state: "trimming", trimKind: "first", words });
      return "continue";
    }
  }

  /** The review's answer as a judge record on top of `base` (the version's own owed record). */
  const recordOf = (base: JudgeRecord, r: Awaited<ReturnType<typeof w.reviewVersion>>): JudgeRecord => {
    const failing = r.checks.filter((c) => !c.pass);
    return {
      ...base, writer: 2, checks: r.checks, hard: r.hard, craft: r.craft, words: r.words, summary: r.summary, trimmed: !!base.trimmed,
      criteria: r.checks.map((c) => ({ key: c.key, pass: c.pass, note: c.reason })), issues: failing.map((c) => `${c.n}. ${c.label}: ${c.reason}`),
      fixInstruction: r.fixInstruction, checkedAt: new Date().toISOString(), runId: r.runId, error: null,
    };
  };
  /** What a reviewed CURRENT version does next (pass, flag, a fix round, a trim). */
  const settleCurrent = async (cv: VersionRow, record: JudgeRecord, next: ReturnType<typeof w.nextWriterStep>): Promise<AutoCheckResult | "continue"> => {
    if (next === "revert") {
      // Oct 22 2026 (v2.1): the aim trim dropped a must-keep point: the longer passing version stands.
      // v2.3: flagged instead when it says the line the trim's review failed on.
      const kept = await restoreBeforeTrim(cv, record, o.requestedBy);
      return { state: kept.state, fixRounds: record.fixRounds, versionId: kept.versionId, reason: kept.state === "flagged" ? "the trim failed a must-fix check; the longer version is kept, flagged: it says the line the trim failed on" : "the trim failed a must-fix check; the longer version is kept" };
    }
    if (next === "pass") {
      await writeJudge(cv.id, { ...record, state: "passed" });
      return { state: "passed", fixRounds: record.fixRounds, versionId: cv.id };
    }
    if (next === "flag" || next === "review") {
      const kept = await finishFlagged(cv, record, o.requestedBy);
      return { state: "flagged", fixRounds: record.fixRounds, versionId: kept };
    }
    await writeJudge(cv.id, { ...record, state: next === "fix" ? "fixing" : "trimming", ...(next === "fix" ? {} : { trimKind: next === "aim-trim" ? ("aim" as const) : ("cap" as const) }) });
    return "continue";
  };

  if (j.state === "pending" || (j.state === "not_checked" && j.attempts < MAX_JUDGE_ATTEMPTS)) {
    if (!o.timeFor(JUDGE_MIN_START_MS)) return stay("out of time");
    let r: Awaited<ReturnType<typeof w.reviewVersion>>;
    try {
      r = await w.reviewVersion(v.id, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline });
    } catch (e) {
      const known = pausedOrRefused(e);
      if (known) return known;
      const msg = e instanceof Error ? e.message : String(e);
      await writeJudge(v.id, { ...j, state: "not_checked", attempts: j.attempts + 1, error: msg.slice(0, 300), checkedAt: new Date().toISOString() });
      return { state: "not_checked", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
    }
    const record = recordOf(j, r);
    return settleCurrent(v, record, w.nextWriterStep({ mustFails: r.mustFails, words: r.words, fixRounds: j.fixRounds, trimmed: !!j.trimmed, aimTrimmed: !!j.aimTrimmed, isAimTrim: !!j.aimTrimOf, maxFixRounds: MAX_FIX_ROUNDS, story: r.story }));
  }

  if (j.state === "fixing" || j.state === "trimming") {
    const trim = j.state === "trimming";
    const first = trim && j.trimKind === "first";
    const aim = trim && j.trimKind === "aim";
    // Oct 23 2026 (never a worse version): a fix round and the cap trim are CANDIDATES. The aim trims keep their
    // own rule: the pre-review one has nothing reviewed to compare, and one that loses a must-keep point is undone.
    const candidateRound = !first && !aim;
    if (candidateRound) {
      const owed = await owedCandidate(scriptId, v.id);
      if (owed) {
        const parent = { v, j };
        const story = (await w.latestWriterRecord(scriptId, v.id))?.brief.videoType === "story";
        // A candidate whose review could not run after every retry is set aside: it can never be shown better.
        if (owed.j.state === "not_checked" && owed.j.attempts >= MAX_JUDGE_ATTEMPTS) {
          const pj = await setAside(owed, parent, owed.j.error ?? "The creative review could not run on this round.");
          return settleCurrent(v, pj, w.nextWriterStep({ mustFails: mustFixFailures(pj.checks ?? []), words: pj.words || v.spokenWordCount || 0, fixRounds: pj.fixRounds, trimmed: !!pj.trimmed, aimTrimmed: !!pj.aimTrimmed, isAimTrim: false, maxFixRounds: MAX_FIX_ROUNDS, story }));
        }
        if (!o.timeFor(JUDGE_MIN_START_MS)) return stay("out of time");
        let r: Awaited<ReturnType<typeof w.reviewVersion>>;
        try {
          r = await w.reviewVersion(owed.v.id, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline });
        } catch (e) {
          const known = pausedOrRefused(e);
          if (known) return known;
          const msg = e instanceof Error ? e.message : String(e);
          await writeJudge(owed.v.id, { ...owed.j, state: "not_checked", attempts: owed.j.attempts + 1, error: msg.slice(0, 300), checkedAt: new Date().toISOString() });
          return { state: "not_checked", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
        }
        const cand = { v: owed.v, j: recordOf(owed.j, r) };
        if (candidateWins(cand, parent, !!(r.story ?? story))) {
          // Better: it becomes the current version (a person's approve or edit in between wins, and it is set aside).
          if (!(await makeVersionCurrent(scriptId, cand.v.id, { expectCurrentId: v.id }))) {
            await setAside(cand, parent, "The script changed while this round ran.");
            return { state: "skipped", fixRounds: j.fixRounds, versionId: v.id, reason: "the script changed while the round ran" };
          }
          return settleCurrent(cand.v, cand.j, w.nextWriterStep({ mustFails: r.mustFails, words: r.words, fixRounds: cand.j.fixRounds, trimmed: !!cand.j.trimmed, aimTrimmed: !!cand.j.aimTrimmed, isAimTrim: false, maxFixRounds: MAX_FIX_ROUNDS, story: r.story }));
        }
        // Not better: it stays in the history; the version it was fixing stays current with the round counted.
        const pj = await setAside(cand, parent);
        return settleCurrent(v, pj, w.nextWriterStep({ mustFails: mustFixFailures(pj.checks ?? []), words: pj.words || v.spokenWordCount || 0, fixRounds: pj.fixRounds, trimmed: !!pj.trimmed, aimTrimmed: !!pj.aimTrimmed, isAimTrim: false, maxFixRounds: MAX_FIX_ROUNDS, story: r.story }));
      }
    }
    if (!o.timeFor(FIX_MIN_START_MS)) return stay("out of time");
    try {
      const { reviseScript } = await import("@/lib/contentGeneration");
      const { WRITER_LENGTH } = await import("@/lib/scriptWriter/rules");
      // The brief's must-keep points ride in every trim and fix: none may be dropped to hit a number.
      const rec = await w.latestWriterRecord(scriptId, v.id);
      const mustKeep = w.mustKeepTexts(rec?.brief);
      const story = rec?.brief.videoType === "story";
      await reviseScript(scriptId, trim ? trimInstruction(j.words ?? 0, mustKeep, { story }) : w.writerFixInstruction(j, mustKeep, { story }), o.requestedBy, "REVISION", {
        autoFix: first
          // v2.4: the pre-review aim trim; over the cap, it is the cap trim too.
          ? { round: 0, trim: "aim", preReview: true, trimmed: (j.words ?? 0) > WRITER_LENGTH.cap }
          : aim
          ? { round: j.fixRounds, trim: "aim", trimmed: !!j.trimmed, aimTrimOf: v.id }
          : trim ? { round: j.fixRounds, trim: "cap", aimTrimmed: !!j.aimTrimmed, candidate: true } : { round: j.fixRounds + 1, trimmed: !!j.trimmed, aimTrimmed: !!j.aimTrimmed, candidate: true },
        unattended: o.unattended, deadline: o.deadline,
      });
    } catch (e) {
      const known = pausedOrRefused(e);
      if (known) return known;
      const msg = e instanceof Error ? e.message : String(e);
      await writeJudge(v.id, { ...j, state: "flagged", error: `The automatic ${trim ? "trim" : "fix"} could not run: ${msg.slice(0, 200)}` });
      return { state: "flagged", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
    }
    return "continue";
  }
  return { state: j.state, fixRounds: j.fixRounds, versionId: v.id };
}

/**
 * Judge the script's current version and fix it when it fails, until it
 * passes, is flagged, or the clock says stop (then the AI cron finishes it).
 * Only a version that carries a judge record still owed (pending / fixing /
 * a not_checked one under its retry limit) is touched, so a person's own
 * revision or edit is never judged or rewritten. Never throws for a judge or
 * fix failure: that is recorded on the version.
 */
export async function autoCheckScript(scriptId: string, opts: { requestedBy?: string | null; unattended: boolean; deadline?: number | null }): Promise<AutoCheckResult> {
  const deadline = opts.deadline ?? Date.now() + DEFAULT_BUDGET_MS;
  const timeFor = (ms: number) => deadline - Date.now() >= ms;
  // Two fix rounds and (the new writer) the cap trim and the aim trim, each followed by a check;
  // v2.4: and the aim trim of the draft before its first review; v2.5: and the third fix round (pipeline.thirdRoundFor).
  for (let guard = 0; guard < 2 * (MAX_FIX_ROUNDS + 5) + 1; guard++) {
    const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { currentVersionId: true, historical: true, sharedVersionId: true } });
    if (!s?.currentVersionId || s.historical) return { state: "skipped", fixRounds: 0, versionId: null, reason: "no live version" };
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: s.currentVersionId } });
    if (!v) return { state: "skipped", fixRounds: 0, versionId: null, reason: "no version" };
    const j = readJudge(v.validationJson);
    if (!j) return { state: "skipped", fixRounds: 0, versionId: v.id, reason: "not an automatic draft" };
    if (v.status !== "DRAFT" && v.status !== "INTERNAL_REVIEW") return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: "already reviewed" };
    const requestedBy = opts.requestedBy ?? v.createdBy ?? "cron";

    // Oct 22 2026: a draft by the new writer gets its independent creative review instead of the judge.
    if (j.writer === 2) {
      const step = await writerReviewStep(scriptId, v, j, !!s.sharedVersionId, { requestedBy, unattended: opts.unattended, deadline: opts.deadline ?? null, timeFor });
      if (step === "continue") continue;
      return step;
    }

    if (j.state === "pending" || (j.state === "not_checked" && j.attempts < MAX_JUDGE_ATTEMPTS)) {
      if (!timeFor(JUDGE_MIN_START_MS)) return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: "out of time" };
      let verdict: Awaited<ReturnType<typeof judgeVersion>>;
      try {
        verdict = await judgeVersion(v.id, { requestedBy, unattended: opts.unattended, deadline: opts.deadline });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Another worker is judging this very version: it records the result.
        if (/already running/i.test(msg)) return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: "judged elsewhere" };
        // The ai_runs switch off, or a daily quota reached: nothing went wrong
        // with this draft; it stays owed and the cron tries again later.
        const name = e instanceof Error ? e.name : "";
        if (name === "AutomationDisabledError" || name === "QuotaExceededError") return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: name, ...(name === "QuotaExceededError" ? { quota: quotaOf(e) } : {}) };
        await writeJudge(v.id, { ...j, state: "not_checked", attempts: j.attempts + 1, error: msg.slice(0, 300), checkedAt: new Date().toISOString() });
        return { state: "not_checked", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
      }
      const record: JudgeRecord = { ...j, criteria: verdict.criteria, issues: verdict.failed.map(issueLine), fixInstruction: verdict.fixInstruction, checkedAt: new Date().toISOString(), runId: verdict.runId, error: null };
      if (!verdict.failed.length) {
        await writeJudge(v.id, { ...record, state: "passed" });
        return { state: "passed", fixRounds: j.fixRounds, versionId: v.id };
      }
      if (j.fixRounds >= MAX_FIX_ROUNDS) {
        const kept = await finishFlagged(v, record, requestedBy);
        return { state: "flagged", fixRounds: j.fixRounds, versionId: kept };
      }
      await writeJudge(v.id, { ...record, state: "fixing" });
      continue;
    }

    if (j.state === "fixing") {
      // Oct 23 2026 (never a worse version): the fix round is a candidate; judged, it becomes current only when better.
      const owed = await owedCandidate(scriptId, v.id);
      if (owed) {
        const parent = { v, j };
        /** The version it was fixing stays current with the round counted: another round, or flagged when they are spent. */
        const keepParent = async (pj: JudgeRecord): Promise<AutoCheckResult | "continue"> => {
          if (pj.fixRounds >= MAX_FIX_ROUNDS) {
            const kept = await finishFlagged(v, pj, requestedBy);
            return { state: "flagged", fixRounds: pj.fixRounds, versionId: kept };
          }
          await writeJudge(v.id, { ...pj, state: "fixing" });
          return "continue";
        };
        if (owed.j.state === "not_checked" && owed.j.attempts >= MAX_JUDGE_ATTEMPTS) {
          const step = await keepParent(await setAside(owed, parent, owed.j.error ?? "The automatic check could not run on this round."));
          if (step === "continue") continue;
          return step;
        }
        if (!timeFor(JUDGE_MIN_START_MS)) return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: "out of time" };
        let verdict: Awaited<ReturnType<typeof judgeVersion>>;
        try {
          verdict = await judgeVersion(owed.v.id, { requestedBy, unattended: opts.unattended, deadline: opts.deadline });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/already running/i.test(msg)) return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: "judged elsewhere" };
          const name = e instanceof Error ? e.name : "";
          if (name === "AutomationDisabledError" || name === "QuotaExceededError") return { state: j.state, fixRounds: j.fixRounds, versionId: v.id, reason: name, ...(name === "QuotaExceededError" ? { quota: quotaOf(e) } : {}) };
          await writeJudge(owed.v.id, { ...owed.j, state: "not_checked", attempts: owed.j.attempts + 1, error: msg.slice(0, 300), checkedAt: new Date().toISOString() });
          return { state: "not_checked", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
        }
        const cand = { v: owed.v, j: { ...owed.j, criteria: verdict.criteria, issues: verdict.failed.map(issueLine), fixInstruction: verdict.fixInstruction, checkedAt: new Date().toISOString(), runId: verdict.runId, error: null } as JudgeRecord };
        if (candidateWins(cand, parent, false)) {
          if (!(await makeVersionCurrent(scriptId, cand.v.id, { expectCurrentId: v.id }))) {
            await setAside(cand, parent, "The script changed while this round ran.");
            return { state: "skipped", fixRounds: j.fixRounds, versionId: v.id, reason: "the script changed while the round ran" };
          }
          if (!verdict.failed.length) {
            await writeJudge(cand.v.id, { ...cand.j, state: "passed" });
            return { state: "passed", fixRounds: cand.j.fixRounds, versionId: cand.v.id };
          }
          if (cand.j.fixRounds >= MAX_FIX_ROUNDS) {
            const kept = await finishFlagged(cand.v, cand.j, requestedBy);
            return { state: "flagged", fixRounds: cand.j.fixRounds, versionId: kept };
          }
          await writeJudge(cand.v.id, { ...cand.j, state: "fixing" });
          continue;
        }
        const step = await keepParent(await setAside(cand, parent));
        if (step === "continue") continue;
        return step;
      }
      if (!timeFor(FIX_MIN_START_MS)) return { state: "fixing", fixRounds: j.fixRounds, versionId: v.id, reason: "out of time" };
      try {
        const { reviseScript } = await import("@/lib/contentGeneration");
        await reviseScript(scriptId, fixInstructionFrom(j), requestedBy, "REVISION", { autoFix: { round: j.fixRounds + 1, candidate: true }, unattended: opts.unattended, deadline: opts.deadline });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/already running/i.test(msg)) return { state: "fixing", fixRounds: j.fixRounds, versionId: v.id, reason: "a revision is running" };
        const name = e instanceof Error ? e.name : "";
        if (name === "AutomationDisabledError" || name === "QuotaExceededError") return { state: "fixing", fixRounds: j.fixRounds, versionId: v.id, reason: name, ...(name === "QuotaExceededError" ? { quota: quotaOf(e) } : {}) };
        await writeJudge(v.id, { ...j, state: "flagged", error: `The automatic fix could not run: ${msg.slice(0, 200)}` });
        return { state: "flagged", fixRounds: j.fixRounds, versionId: v.id, reason: msg };
      }
      continue;
    }
    return { state: j.state, fixRounds: j.fixRounds, versionId: v.id };
  }
  return { state: "skipped", fixRounds: 0, versionId: null, reason: "loop guard" };
}

/**
 * THE CRON'S HALF (15-minute AI job): finish the checks a draft's own run had
 * no time for. Current versions of live scripts, written in the last week,
 * whose judge record is still owed. Each start is checked against the clock.
 */
export async function sweepScriptChecks(opts: { max?: number; budgetMs?: number; minStartMs?: number } = {}): Promise<{ checked: number; passed: number; flagged: number; notChecked: number; outOfTime: boolean; clientsAtCap: string[] }> {
  const started = Date.now();
  const deadline = started + (opts.budgetMs ?? 90_000);
  const since = new Date(started - 7 * 24 * 3600_000);
  const rows = await prisma.contentScriptVersion.findMany({
    where: {
      status: { in: ["DRAFT", "INTERNAL_REVIEW"] }, createdAt: { gte: since },
      OR: [{ validationJson: { contains: '"state":"pending"' } }, { validationJson: { contains: '"state":"fixing"' } }, { validationJson: { contains: '"state":"not_checked"' } }, { validationJson: { contains: '"state":"trimming"' } }],
    },
    orderBy: { createdAt: "asc" }, take: 50, select: { id: true, scriptId: true, createdBy: true, validationJson: true, enrollmentId: true },
  });
  const current = new Set((await prisma.contentScript.findMany({ where: { id: { in: rows.map((r) => r.scriptId) }, historical: false }, select: { currentVersionId: true } })).map((s) => s.currentVersionId));
  let checked = 0, passed = 0, flagged = 0, notChecked = 0, outOfTime = false;
  const seen = new Set<string>();
  // Oct 22 2026: a client whose own daily cap is spent is skipped, and the
  // sweep carries on with everyone else (it used to stop at the first refusal,
  // so one busy client stalled every client's checks). The program-wide cap
  // and the ai_runs switch still stop it: those refuse every row alike.
  const atCap = new Set<string>();
  for (const r of rows) {
    if (checked >= (opts.max ?? 4)) break;
    if (!current.has(r.id) || seen.has(r.scriptId) || atCap.has(r.enrollmentId)) continue;
    const j = readJudge(r.validationJson);
    if (!j || (j.state === "not_checked" && j.attempts >= MAX_JUDGE_ATTEMPTS)) continue;
    if (deadline - Date.now() < (opts.minStartMs ?? JUDGE_MIN_START_MS)) { outOfTime = true; break; }
    seen.add(r.scriptId);
    const res = await autoCheckScript(r.scriptId, { requestedBy: r.createdBy ?? "cron", unattended: true, deadline });
    if (res.reason === "QuotaExceededError" && res.quota === "client") { atCap.add(r.enrollmentId); continue; }
    checked++;
    if (res.state === "passed") passed++;
    else if (res.state === "flagged") flagged++;
    else if (res.state === "not_checked") notChecked++;
    if (res.reason === "out of time") { outOfTime = true; break; }
    // ai_runs off is the stop button, and the program-wide cap refuses every row alike.
    if (res.reason === "AutomationDisabledError" || res.reason === "QuotaExceededError") break;
  }
  return { checked, passed, flagged, notChecked, outOfTime, clientsAtCap: [...atCap] };
}
