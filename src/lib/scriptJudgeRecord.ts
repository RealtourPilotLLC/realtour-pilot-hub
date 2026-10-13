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
//
// No I/O here, so the server pages and the drill can read it.
// ---------------------------------------------------------------------------

export type JudgeState = "pending" | "fixing" | "passed" | "flagged" | "not_checked";
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
};

/** Two automatic fix rounds at most (Jordan, Oct 14 2026). */
export const MAX_FIX_ROUNDS = 2;

export function pendingJudge(fixRounds = 0): JudgeRecord {
  return { state: "pending", fixRounds, criteria: [], issues: [], fixInstruction: null, checkedAt: null, runId: null, attempts: 0, error: null };
}

/** The judge record in a version's validationJson, or null (a person's version, or one from before Oct 14 2026). */
export function readJudge(validationJson: string | null | undefined): JudgeRecord | null {
  if (!validationJson) return null;
  try {
    const v = JSON.parse(validationJson) as { judge?: Partial<JudgeRecord> | null };
    const j = v?.judge;
    if (!j || typeof j !== "object" || typeof j.state !== "string") return null;
    return {
      state: (["pending", "fixing", "passed", "flagged", "not_checked"] as const).includes(j.state as JudgeState) ? (j.state as JudgeState) : "not_checked",
      fixRounds: Number(j.fixRounds) || 0,
      criteria: Array.isArray(j.criteria) ? j.criteria : [],
      issues: Array.isArray(j.issues) ? j.issues.filter((x): x is string => typeof x === "string") : [],
      fixInstruction: typeof j.fixInstruction === "string" ? j.fixInstruction : null,
      checkedAt: typeof j.checkedAt === "string" ? j.checkedAt : null,
      runId: typeof j.runId === "string" ? j.runId : null,
      attempts: Number(j.attempts) || 0,
      error: typeof j.error === "string" ? j.error : null,
      keptVersionNo: typeof j.keptVersionNo === "number" ? j.keptVersionNo : null,
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
  switch (j.state) {
    case "passed": return { tone: "ok", text: fixed ? `${fixed} · checked: passed` : "Checked: passed" };
    case "flagged": return { tone: "warn", text: `${fixed ? `${fixed} · ` : ""}Still flagged: ${j.issues[0] ?? j.error ?? "the automatic check did not pass"}` };
    case "not_checked": return { tone: "muted", text: "Not checked (the automatic check could not run)" };
    case "pending":
    case "fixing": return { tone: "muted", text: `${fixed ? `${fixed} · ` : ""}Automatic check pending` };
  }
}

/** Sort key for the review queue: flagged first. */
export function judgeFlagged(j: JudgeRecord | null): boolean {
  return j?.state === "flagged";
}
