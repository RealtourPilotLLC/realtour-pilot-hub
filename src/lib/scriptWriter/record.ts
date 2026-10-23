// ---------------------------------------------------------------------------
// WHAT THE WRITER KEEPS WITH A SCRIPT (Oct 22 2026). Pure: types, a reader
// and the script card's view of it. No I/O, so the server page and the drill
// read it the same way.
//
// Stored on the version, in validationJson.writer, beside the format check and
// the automatic check's judge record (schema is off limits; validationJson is
// the version's existing bag of staff-only notes). The portal never reads it.
//
//   brief      the topic brief written before the draft: the one message, the
//              viewer, why the topic was chosen, the pillar, what she said
//              (verbatim, with source and time), must-keep / optional /
//              excluded, contradictions, the close type and the target length;
//              verified facts, her opinions, her creative ideas and OUR
//              assumptions kept apart
//   passages   the call passages the brief was built from (verbatim, with the
//              lines around them), so the reviewer and every fix round read
//              exactly what the writer read
//   hooks      the five hooks, scored; `chosen` is the winner's index
//   rationale  the short internal note for Jordan: the hook, the takeaway, how
//              her strategy shaped it
// ---------------------------------------------------------------------------

import { readJudge, type JudgeRecord } from "../scriptJudgeRecord";
import type { HookCandidate, ReviewCheckResult, HardFinding, CraftScores } from "./rules";
import { reviewHeadline, CRAFT_PARTS, CRAFT_PASS } from "./rules";

export type BriefItem = { text: string; source: string };
export type WriterPassage = { id: string; source: string; time: string | null; speaker: string; kind: string; quote: string; context: string; why: string };

export type TopicBrief = {
  /**
   * Oct 22 2026 (the listening fix): the brief CHOOSES. A personal story or an
   * educational video; the interviewer's question for the topic (its intent);
   * one angle and one proof. A brief written before has none of these.
   */
  videoType?: "story" | "educational";
  whatWeAsked?: string;
  angle?: string;
  /** v2.3: isHerStory is true when the proof is a real moment she told (her own moment then wins a hook tie). */
  proof?: (BriefItem & { isHerStory?: boolean }) | null;
  centralMessage: string;
  viewer: string;
  whyChosen: string;
  pillar: string;
  whatSheSaid: { passageId: string; quote: string; source: string; time: string | null }[];
  /** v2.1: POINTS in plain words (meaning), never quotes of her sentences. */
  mustKeep: BriefItem[];
  /** v2.1: up to five short phrases of hers, strong and natural on camera, worth saying exactly. */
  herPhrases?: BriefItem[];
  optional: BriefItem[];
  excluded: { text: string; reason: string }[];
  contradictions: { text: string; sources: string }[];
  verifiedFacts: BriefItem[];
  opinions: BriefItem[];
  creativeIdeas: BriefItem[];
  ourAssumptions: BriefItem[];
  closeType: "cta" | "callback";
  closeWhy: string;
  /** `words` (Oct 22 2026, v2.1): what the draft writes toward; a brief written before it has none (75). */
  target: { aim: [number, number]; cap: number; seconds: [number, number]; words?: number };
  /**
   * v2.5: what code keeps out of the script, for code only (pipeline.briefFrom):
   * a deal still in progress ("live": the proof, its points and its passages'
   * words, with the passage ids) or a story she already told on camera
   * ("used"). Never shown to the writer or the hooks step (briefText leaves
   * it out; the excluded list names it); pickHook sets aside a hook that tells
   * one, and the review fails a script that tells a live one (live_deal).
   */
  heldBack?: { kind: "live" | "used"; ids: string[]; text: string }[];
};

export type WriterRationale = { hook: string; takeaway: string; strategy: string };

export type WriterFact = { id: string; body: string; label: string };

export type WriterRecord = {
  v: 2;
  version: string;
  brief: TopicBrief;
  passages: WriterPassage[];
  excludedPassages: { quote: string; source: string; reason: string }[];
  hooks: HookCandidate[];
  chosen: number;
  /** v2.3: why the chosen hook was a fallback (no hook reached curiosity 4 and tension 4), or null. */
  hookFallback?: string | null;
  rationale: WriterRationale | null;
  facts: WriterFact[];
  sources: { calls: string[]; olderWindows: number; relatedScripts: string[]; voiceRefs: { title: string; why: string }[]; answers: number };
  runs: { retrieval: string | null; brief: string | null; hooks: string | null; draft: string | null; /** Oct 22 2026: the second retrieval, over her older calls. */ olderRetrieval?: string | null };
  /** Phase 3's offline test: the moment the sources were read as of. Null = now. */
  asOf: string | null;
};

/** The automatic check's record, as the new reviewer fills it (scriptJudgeRecord.JudgeRecord plus these). */
export type WriterJudgeExtra = { writer: 2; checks: ReviewCheckResult[]; hard: HardFinding[]; words: number; trimmed: boolean; summary: string | null; /** v2.3: the five parts scored. */ craft?: CraftScores | null };

/** The writer's record on a version, or null (a version the old writer, a person or an import made). */
export function readWriter(validationJson: string | null | undefined): WriterRecord | null {
  if (!validationJson) return null;
  try {
    const w = (JSON.parse(validationJson) as { writer?: Partial<WriterRecord> | null }).writer;
    if (!w || typeof w !== "object" || w.v !== 2 || !w.brief) return null;
    return {
      v: 2, version: String(w.version ?? ""), brief: w.brief as TopicBrief,
      passages: Array.isArray(w.passages) ? w.passages : [], excludedPassages: Array.isArray(w.excludedPassages) ? w.excludedPassages : [],
      hooks: Array.isArray(w.hooks) ? w.hooks : [], chosen: typeof w.chosen === "number" ? w.chosen : -1, hookFallback: typeof w.hookFallback === "string" ? w.hookFallback : null, rationale: w.rationale ?? null,
      facts: Array.isArray(w.facts) ? w.facts : [],
      sources: w.sources ?? { calls: [], olderWindows: 0, relatedScripts: [], voiceRefs: [], answers: 0 },
      runs: w.runs ?? { retrieval: null, brief: null, hooks: null, draft: null }, asOf: typeof w.asOf === "string" ? w.asOf : null,
    };
  } catch { return null; }
}

/** The new reviewer's part of a judge record, or null when the old judge (or nobody) checked it. */
export function readWriterJudge(validationJson: string | null | undefined): (JudgeRecord & WriterJudgeExtra) | null {
  const j = readJudge(validationJson);
  if (!j) return null;
  try {
    const raw = (JSON.parse(validationJson!) as { judge?: Partial<WriterJudgeExtra> }).judge ?? {};
    if (raw.writer !== 2) return null;
    return { ...j, writer: 2, checks: Array.isArray(raw.checks) ? raw.checks : [], hard: Array.isArray(raw.hard) ? raw.hard : [], words: Number(raw.words) || 0, trimmed: raw.trimmed === true, summary: typeof raw.summary === "string" ? raw.summary : null, aimTrimmed: j.aimTrimmed === true, craft: raw.craft && typeof raw.craft === "object" ? raw.craft : null };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// The script card's view (staff only).
// ---------------------------------------------------------------------------

export type WriterCardUi = {
  review: {
    state: JudgeRecord["state"];
    headline: string | null;
    failing: { n: number; label: string; level: "must-fix" | "flag"; reason: string }[];
    passing: { n: number; label: string }[];
    fixRounds: number;
    trimmed: boolean;
    note: string | null;
    /** v2.3: the craft block, part by part (score, the psychology note, under the bar or not). */
    craft: { label: string; score: number; note: string; under: boolean }[];
  } | null;
  /** v2.1: why a longer version was kept (the aim trim dropped a must-keep point). */
  lengthNote: string | null;
  rationale: WriterRationale | null;
  brief: Omit<TopicBrief, "whatSheSaid"> & { whatSheSaid: { quote: string; source: string }[] };
  /** v2.3: `max` is the most the scores could add to (35 before tension was scored, 40 since); `weak` why a hook was under the bar. */
  hooks: { text: string; total: number; max: number; chosen: boolean; disqualified: string | null; weak: string | null }[];
  /** v2.3: why the chosen hook was a fallback, or null. */
  hookFallback: string | null;
};

const REVIEW_STATE_NOTE: Record<JudgeRecord["state"], string | null> = {
  pending: "Creative review pending",
  fixing: "Creative review: fixing what failed",
  trimming: "Creative review: trimming to the 110-word cap",
  passed: null,
  flagged: "Still failing a must-fix check after the automatic fixes: read the failing checks before approving.",
  not_checked: "Not reviewed (the creative review could not run)",
  // Oct 23 2026: a fix round that was not better than the version it fixed (kept in the history, never current).
  set_aside: "Set aside: not better than the version it was fixing, which stayed current",
};

/** Everything the card shows from one version's validationJson, or null for a version the new writer did not make. */
export function writerCardOf(validationJson: string | null | undefined): WriterCardUi | null {
  const w = readWriter(validationJson);
  if (!w) return null;
  const j = readWriterJudge(validationJson);
  const checks = j?.checks ?? [];
  let lengthNote: string | null = null;
  try { const n = (JSON.parse(validationJson!) as { lengthNote?: unknown }).lengthNote; lengthNote = typeof n === "string" && n.trim() ? n : null; } catch { lengthNote = null; }
  return {
    lengthNote,
    review: j
      ? {
          state: j.state,
          headline: checks.length ? reviewHeadline(checks) : null,
          failing: checks.filter((c) => !c.pass).map((c) => ({ n: c.n, label: c.label, level: c.level, reason: c.reason })),
          passing: checks.filter((c) => c.pass).map((c) => ({ n: c.n, label: c.label })),
          fixRounds: j.fixRounds,
          trimmed: j.trimmed || j.aimTrimmed === true,
          note: j.state === "not_checked" && j.error ? `${REVIEW_STATE_NOTE.not_checked}: ${j.error}` : REVIEW_STATE_NOTE[j.state],
          craft: j.craft ? CRAFT_PARTS.map((p) => ({ label: p.label, score: Number(j.craft?.[p.key]?.score) || 0, note: String(j.craft?.[p.key]?.note ?? ""), under: (Number(j.craft?.[p.key]?.score) || 0) < CRAFT_PASS })) : [],
        }
      : null,
    rationale: w.rationale,
    brief: { ...w.brief, whatSheSaid: (w.brief.whatSheSaid ?? []).map((p) => ({ quote: p.quote, source: [p.source, p.time].filter(Boolean).join(" at ") })) },
    hooks: w.hooks.map((h, i) => ({ text: h.text, total: h.total, max: Object.keys(h.scores ?? {}).length * 5 || 35, chosen: i === w.chosen, disqualified: h.disqualified, weak: h.disqualified ? null : h.weak ?? null })),
    hookFallback: w.hookFallback ?? null,
  };
}
