// ---------------------------------------------------------------------------
// DRILL HELPER: the automatic script judge (Oct 14 2026, src/lib/scriptJudge.ts).
//
// Every AI script draft is now followed by one judge call. A drill whose model
// stub is about something else (drafting, uploads, the queue) answers the
// judge with a PASS here, before it counts its own model calls, so its counts
// and its stubbed scripts stay what they were:
//
//   if (isJudgeCall(opts.system)) return passingJudge();
//
// A strategy approval now also builds the creative identity with one call;
// isIdentityCall / plainIdentity answer it the same way.
//
// oct14-creative-engine.ts drives the judge itself (fail, fix, pass, flagged).
// ---------------------------------------------------------------------------

/** The judge's system prompt says this (contentPolicy/prompts.ts buildScriptJudgePrompt). */
export const JUDGE_SYSTEM_RE = /You are the quality judge for ONE monthly personal-brand video script/;

export function isJudgeCall(system: string | null | undefined): boolean {
  return JUDGE_SYSTEM_RE.test(system ?? "");
}

/** The creative identity call (src/lib/creativeIdentity.ts), which a strategy approval now triggers. */
export const IDENTITY_SYSTEM_RE = /You build a short creative identity for ONE real estate agent/;

export function isIdentityCall(system: string | null | undefined): boolean {
  return IDENTITY_SYSTEM_RE.test(system ?? "");
}

/** A plain, quiet identity: no humour, no acting, nothing stated. */
export function plainIdentity() {
  return {
    result: { humorStyle: "none", comedyComfort: "no_acting", onCameraEnergy: "calm and steady", toneWords: ["clear", "warm", "direct"], boundaries: [], interests: [], formatsLiked: [], formatsAvoided: [], filmingConstraints: [] },
    usage: { inputTokens: 600, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: "drill-identity-stub",
  };
}

const KEYS =["hook", "rehook", "buildup", "payoff", "close", "voice", "truth", "skit"] as const;

/** A model answer that passes every criterion. */
export function passingJudge() {
  return {
    result: { criteria: KEYS.map((key) => ({ key, pass: true, note: "ok" })), fixInstruction: null },
    usage: { inputTokens: 400, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
    model: "drill-judge-stub",
  };
}
