// ---------------------------------------------------------------------------
// THE AUTOMATIC CHECK'S RECORD (Oct 14 2026), the pure half of scriptJudge.ts.
//
// Every AI draft of a monthly script is judged once by the model and, when it
// fails, revised with the judge's notes (two rounds at most). What happened is
// stored on the version, in validationJson.judge, beside the format check and
// the writer's angle. Staff see one line ("Checked: passed", "Auto-fixed 1
// time", "Still flagged: …", "Not checked"); the portal never reads it.
//
//   pending      owed a judge call (a new draft or an auto-fix version)
//   fixing       judged, failed, a fix round is owed
//   passed       judged and passed (fixRounds says how many fixes it took)
//   flagged      still failing after the last round, or the fix could not run
//   not_checked  the judge call itself failed; the draft stands unjudged
//   trimming     (Oct 22 2026, the new writer only) the fix rounds are spent and
//                the script is still over the 110-word cap: one trim pass owed
//   set_aside    (Oct 23 2026) an automatic fix round (or cap trim) that was
//                reviewed and was NOT better than the version it was fixing:
//                it stays in the history and never became the current version
//
// Oct 23 2026, NEVER A WORSE VERSION: a fix round is written into the history
// as a CANDIDATE (candidateOf = the version it fixes; the script's current
// version does not move) and becomes current only when it is better by
// rules.isBetterAttempt (fewer must-fix failures, then the craft total, then
// the length rule). Otherwise it is set_aside and the version it was fixing
// stays current, carrying the rounds spent on it (fixRounds).
//
// Oct 22 2026: a draft by the new script writer (src/lib/scriptWriter) is
// checked by its independent creative review instead of this judge. Its record
// is the same shape with `writer: 2` and the review's checks (`checks`, 13 since v2.3, each
// must-fix or flag), the code's hard numbers (`hard`), the word count and
// whether the trim pass ran. readJudge keeps those fields, so every state
// change written through it keeps saying which reviewer owns the version.
//
// No I/O here, so the server pages and the drill can read it.
// ---------------------------------------------------------------------------

import type { ReviewCheckResult, HardFinding, CraftScores, AttemptScore } from "./scriptWriter/rules";
import { bestAttempt } from "./scriptWriter/rules";

export type JudgeState = "pending" | "fixing" | "passed" | "flagged" | "not_checked" | "trimming" | "set_aside";
export type JudgeCriterionResult = { key: string; pass: boolean; note: string };

export type JudgeRecord = {
  state: JudgeState;
  /** Automatic fix rounds that produced this version (0 = the draft itself). */
  fixRounds: number;
  criteria: JudgeCriterionResult[];
  /** The failing criteria, one line each, for the staff line and the next fix. */
  issues: string[];
  /** The judge's own instruction for the fix round (state "fixing"). */
  fixInstruction?: string | null;
  checkedAt: string | null;
  runId: string | null;
  /** Judge calls that failed on this version (state "not_checked"). */
  attempts: number;
  error?: string | null;
  /** When the auto-check kept an earlier, better attempt: that version's number. */
  keptVersionNo?: number | null;
  // Oct 22 2026, the new writer's creative review (see the header).
  writer?: 2;
  checks?: ReviewCheckResult[];
  hard?: HardFinding[];
  words?: number;
  /** The trim pass for the 110-word cap ran. */
  trimmed?: boolean;
  summary?: string | null;
  /** v2.3: the review's craft block (hook, re-hook, build-up, payoff, close scored 1 to 5, a note each). */
  craft?: CraftScores | null;
  /**
   * Oct 22 2026 (v2.1): the ONE aim trim (v2.3: toward 65 to 75, for a passing draft
   * over 78) ran (aimTrimmed); on the version it produced, aimTrimOf names the
   * version it was trimmed from, so a trim that lost a must-keep point is
   * undone; trimKind says which trim a "trimming" state owes.
   */
  aimTrimmed?: boolean;
  aimTrimOf?: string | null;
  /** v2.4: "first" = the aim trim of a draft BEFORE its first review (nothing reviewed to go back to). */
  trimKind?: "cap" | "aim" | "first";
  /** Oct 23 2026: an automatic round written as a candidate: the version it was fixing (it becomes current only when better). */
  candidateOf?: string | null;
  /** Oct 23 2026 (state set_aside): the version number that stayed current instead. */
  keptInstead?: number | null;
};

/** Two automatic fix rounds at most (Jordan, Oct 14 2026). */
export const MAX_FIX_ROUNDS = 2;

export function pendingJudge(fixRounds = 0, opts: { writer?: boolean; trimmed?: boolean; aimTrimmed?: boolean; aimTrimOf?: string | null; /** Oct 23 2026: a candidate round: the version it fixes. */ candidateOf?: string | null } = {}): JudgeRecord {
  return {
    state: "pending", fixRounds, criteria: [], issues: [], fixInstruction: null, checkedAt: null, runId: null, attempts: 0, error: null,
    ...(opts.candidateOf ? { candidateOf: opts.candidateOf } : {}),
    ...(opts.writer ? { writer: 2 as const, checks: [], hard: [], trimmed: !!opts.trimmed, aimTrimmed: !!opts.aimTrimmed, aimTrimOf: opts.aimTrimOf ?? null } : {}),
  };
}

/**
 * A reviewed version as the "never a worse version" rule compares it
 * (rules.isBetterAttempt), or null when it has no review to compare
 * (pending, never checked, a person's version). The new writer's review:
 * its must-fix checks failing, its craft block, its word count. The old
 * judge: every failed criterion counts (it has no levels and no craft).
 */
export function attemptScoreOf(j: JudgeRecord | null, words: number | null | undefined, story?: boolean | null): AttemptScore | null {
  if (!j) return null;
  const w = j.words || words || 0;
  if (j.writer === 2) {
    if (!(j.checks ?? []).length) return null;
    return { mustFix: (j.checks ?? []).filter((c) => !c.pass && c.level === "must-fix").length, craft: j.craft ?? null, words: w, story: !!story };
  }
  if (!j.criteria.length) return null;
  return { mustFix: j.criteria.filter((c) => !c.pass).length, craft: null, words: w, story: !!story };
}

/** The Oct 22 2026 pause marker (scripts/_live/oct22-pause-redo-checks.ts): Jordan set those rounds aside himself. */
export const OCT22_PAUSE_RE = /Paused on Oct 22/;

export type VersionForPick = { id: string; versionNo: number; validationJson: string | null; spokenWordCount: number | null };

/**
 * THE DRY RUN'S RULE (Oct 23 2026, scripts/_live/oct23-best-version-current.ts).
 * Of a script's other versions the automatic check reviewed, the one that is
 * better than the current version by rules.isBetterAttempt (fewer must-fix
 * failures, then the craft total, then the length rule), or null when the
 * current one is the best (a tie keeps it). Only versions the same reviewer
 * judged are compared (the new writer's review, or the old judge); a version
 * the Oct 22 pause set aside is never proposed; a current version with no
 * review of its own (a person's edit, never checked) is never replaced. On a
 * tie between two others, the earlier one (the original, not its copy). Pure.
 */
export function betterEarlierVersion<T extends VersionForPick>(current: T, others: readonly T[], story?: boolean | null): { pick: T; score: AttemptScore; currentScore: AttemptScore } | null {
  const cj = readJudge(current.validationJson);
  const currentScore = attemptScoreOf(cj, current.spokenWordCount, story);
  if (!cj || !currentScore) return null;
  const pool: { v: T; s: AttemptScore }[] = [];
  for (const v of [...others].sort((a, b) => a.versionNo - b.versionNo)) {
    if (v.id === current.id) continue;
    const j = readJudge(v.validationJson);
    if (!j || (j.writer === 2) !== (cj.writer === 2) || OCT22_PAUSE_RE.test(j.error ?? "")) continue;
    const s = attemptScoreOf(j, v.spokenWordCount, story);
    if (s) pool.push({ v, s });
  }
  const i = bestAttempt([currentScore, ...pool.map((x) => x.s)]);
  if (i <= 0) return null;
  return { pick: pool[i - 1].v, score: pool[i - 1].s, currentScore };
}

/** The judge record in a version's validationJson, or null (a person's version, or one from before Oct 14 2026). */
export function readJudge(validationJson: string | null | undefined): JudgeRecord | null {
  if (!validationJson) return null;
  try {
    const v = JSON.parse(validationJson) as { judge?: Partial<JudgeRecord> | null };
    const j = v?.judge;
    if (!j || typeof j !== "object" || typeof j.state !== "string") return null;
    return {
      state: (["pending", "fixing", "passed", "flagged", "not_checked", "trimming", "set_aside"] as const).includes(j.state as JudgeState) ? (j.state as JudgeState) : "not_checked",
      fixRounds: Number(j.fixRounds) || 0,
      criteria: Array.isArray(j.criteria) ? j.criteria : [],
      issues: Array.isArray(j.issues) ? j.issues.filter((x): x is string => typeof x === "string") : [],
      fixInstruction: typeof j.fixInstruction === "string" ? j.fixInstruction : null,
      checkedAt: typeof j.checkedAt === "string" ? j.checkedAt : null,
      runId: typeof j.runId === "string" ? j.runId : null,
      attempts: Number(j.attempts) || 0,
      error: typeof j.error === "string" ? j.error : null,
      keptVersionNo: typeof j.keptVersionNo === "number" ? j.keptVersionNo : null,
      ...(typeof j.candidateOf === "string" ? { candidateOf: j.candidateOf } : {}),
      ...(typeof j.keptInstead === "number" ? { keptInstead: j.keptInstead } : {}),
      ...(j.writer === 2
        ? {
            writer: 2 as const, checks: Array.isArray(j.checks) ? j.checks : [], hard: Array.isArray(j.hard) ? j.hard : [], words: Number(j.words) || 0, trimmed: j.trimmed === true, summary: typeof j.summary === "string" ? j.summary : null, craft: j.craft && typeof j.craft === "object" ? j.craft : null,
            aimTrimmed: j.aimTrimmed === true, aimTrimOf: typeof j.aimTrimOf === "string" ? j.aimTrimOf : null, ...(j.trimKind === "aim" || j.trimKind === "cap" || j.trimKind === "first" ? { trimKind: j.trimKind } : {}),
          }
        : {}),
    };
  } catch { return null; }
}

/** The writer's angle stored with a draft (validationJson.angle), or null. Staff only. */
export function readAngle(validationJson: string | null | undefined): Record<string, string> | null {
  if (!validationJson) return null;
  try {
    const a = (JSON.parse(validationJson) as { angle?: unknown }).angle;
    if (!a || typeof a !== "object" || Array.isArray(a)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) if (typeof v === "string" && v.trim()) out[k] = v;
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

/** The one line staff see on a script, or null when the version was never meant to be checked. */
export function judgeLine(j: JudgeRecord | null): { tone: "ok" | "warn" | "muted"; text: string } | null {
  if (!j) return null;
  const fixed = j.fixRounds ? `Auto-fixed ${j.fixRounds} time${j.fixRounds === 1 ? "" : "s"}` : "";
  // Oct 22 2026: the new writer's creative review says it in its own words.
  if (j.writer === 2) {
    const checks = j.checks ?? [];
    const head = checks.length ? `Creative review: ${checks.filter((c) => c.pass).length} of ${checks.length} pass` : "Creative review";
    const lead = [fixed, j.trimmed ? "trimmed" : ""].filter(Boolean).join(", ");
    switch (j.state) {
      case "passed": return { tone: "ok", text: `${head}${lead ? ` · ${lead}` : ""}` };
      case "flagged": return { tone: "warn", text: `${head}${lead ? ` · ${lead}` : ""} · still failing a must-fix check` };
      case "not_checked": return { tone: "muted", text: "Not reviewed (the creative review could not run)" };
      case "set_aside": return { tone: "muted", text: `Set aside: not better than v${j.keptInstead ?? "?"}, which stayed current` };
      default: return { tone: "muted", text: `${lead ? `${lead} · ` : ""}Creative review pending` };
    }
  }
  switch (j.state) {
    case "passed": return { tone: "ok", text: fixed ? `${fixed} · checked: passed` : "Checked: passed" };
    case "flagged": return { tone: "warn", text: `${fixed ? `${fixed} · ` : ""}Still flagged: ${j.issues[0] ?? j.error ?? "the automatic check did not pass"}` };
    case "not_checked": return { tone: "muted", text: "Not checked (the automatic check could not run)" };
    case "set_aside": return { tone: "muted", text: `Set aside: not better than v${j.keptInstead ?? "?"}, which stayed current` };
    case "pending":
    case "fixing":
    case "trimming": return { tone: "muted", text: `${fixed ? `${fixed} · ` : ""}Automatic check pending` };
  }
}

/** Sort key for the review queue: flagged first. */
export function judgeFlagged(j: JudgeRecord | null): boolean {
  return j?.state === "flagged";
}
