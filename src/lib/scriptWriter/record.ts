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
import type { HookCandidate, ReviewCheckResult, HardFinding } from "./rules";
import { reviewHeadline } from "./rules";

export type BriefItem = { text: string; source: string };
export type WriterPassage = { id: string; source: string; time: string | null; speaker: string; kind: string; quote: string; context: string; why: string };

export type TopicBrief = {
  centralMessage: string;
  viewer: string;
  whyChosen: string;
  pillar: string;
  whatSheSaid: { passageId: string; quote: string; source: string; time: string | null }[];
  mustKeep: BriefItem[];
  optional: BriefItem[];
  excluded: { text: string; reason: string }[];
  contradictions: { text: string; sources: string }[];
  verifiedFacts: BriefItem[];
  opinions: BriefItem[];
  creativeIdeas: BriefItem[];
  ourAssumptions: BriefItem[];
  closeType: "cta" | "callback";
  closeWhy: string;
  target: { aim: [number, number]; cap: number; seconds: [number, number] };
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
  rationale: WriterRationale | null;
  facts: WriterFact[];
  sources: { calls: string[]; olderWindows: number; relatedScripts: string[]; voiceRefs: { title: string; why: string }[]; answers: number };
  runs: { retrieval: string | null; brief: string | null; hooks: string | null; draft: string | null };
  /** Phase 3's offline test: the moment the sources were read as of. Null = now. */
  asOf: string | null;
};

/** The automatic check's record, as the new reviewer fills it (scriptJudgeRecord.JudgeRecord plus these). */
export type WriterJudgeExtra = { writer: 2; checks: ReviewCheckResult[]; hard: HardFinding[]; words: number; trimmed: boolean; summary: string | null };

/** The writer's record on a version, or null (a version the old writer, a person or an import made). */
export function readWriter(validationJson: string | null | undefined): WriterRecord | null {
  if (!validationJson) return null;
  try {
    const w = (JSON.parse(validationJson) as { writer?: Partial<WriterRecord> | null }).writer;
    if (!w || typeof w !== "object" || w.v !== 2 || !w.brief) return null;
    return {
      v: 2, version: String(w.version ?? ""), brief: w.brief as TopicBrief,
      passages: Array.isArray(w.passages) ? w.passages : [], excludedPassages: Array.isArray(w.excludedPassages) ? w.excludedPassages : [],
      hooks: Array.isArray(w.hooks) ? w.hooks : [], chosen: typeof w.chosen === "number" ? w.chosen : -1, rationale: w.rationale ?? null,
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
    return { ...j, writer: 2, checks: Array.isArray(raw.checks) ? raw.checks : [], hard: Array.isArray(raw.hard) ? raw.hard : [], words: Number(raw.words) || 0, trimmed: raw.trimmed === true, summary: typeof raw.summary === "string" ? raw.summary : null };
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
  } | null;
  rationale: WriterRationale | null;
  brief: Omit<TopicBrief, "whatSheSaid"> & { whatSheSaid: { quote: string; source: string }[] };
  hooks: { text: string; total: number; chosen: boolean; disqualified: string | null }[];
};

const REVIEW_STATE_NOTE: Record<JudgeRecord["state"], string | null> = {
  pending: "Creative review pending",
  fixing: "Creative review: fixing what failed",
  trimming: "Creative review: trimming to the 110-word cap",
  passed: null,
  flagged: "Still failing a must-fix check after the automatic fixes: read the failing checks before approving.",
  not_checked: "Not reviewed (the creative review could not run)",
};

/** Everything the card shows from one version's validationJson, or null for a version the new writer did not make. */
export function writerCardOf(validationJson: string | null | undefined): WriterCardUi | null {
  const w = readWriter(validationJson);
  if (!w) return null;
  const j = readWriterJudge(validationJson);
  const checks = j?.checks ?? [];
  return {
    review: j
      ? {
          state: j.state,
          headline: checks.length ? reviewHeadline(checks) : null,
          failing: checks.filter((c) => !c.pass).map((c) => ({ n: c.n, label: c.label, level: c.level, reason: c.reason })),
          passing: checks.filter((c) => c.pass).map((c) => ({ n: c.n, label: c.label })),
          fixRounds: j.fixRounds,
          trimmed: j.trimmed,
          note: j.state === "not_checked" && j.error ? `${REVIEW_STATE_NOTE.not_checked}: ${j.error}` : REVIEW_STATE_NOTE[j.state],
        }
      : null,
    rationale: w.rationale,
    brief: { ...w.brief, whatSheSaid: (w.brief.whatSheSaid ?? []).map((p) => ({ quote: p.quote, source: [p.source, p.time].filter(Boolean).join(" at ") })) },
    hooks: w.hooks.map((h, i) => ({ text: h.text, total: h.total, chosen: i === w.chosen, disqualified: h.disqualified })),
  };
}
