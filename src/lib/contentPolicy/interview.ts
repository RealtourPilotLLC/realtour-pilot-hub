// ---------------------------------------------------------------------------
// The guided topic interview (spec §6) as DATA: the six question rules in
// order, adaptive follow-up conditions, skip / "I don't know" handling, and
// assembleScriptInputs() which turns answers into the generator input with an
// explicit gap for every piece of substance the client did not supply.
//
// One concise question at a time, usually four to six substantive questions,
// follow-ups only when something important is missing, known answers reused.
// Never invent client stories, outcomes, statistics, credentials, anecdotes,
// offers or guarantees — an unanswered question is a gap, not a sentence.
//
// No AI calls here: nextQuestion() is a pure selector, the prompt builder in
// prompts.ts phrases the adaptive follow-up when one is needed.
// ---------------------------------------------------------------------------

import { GENERATION_POLICY_VERSION, type Gap, type PolicyStamp, makeGap, policyStamp } from "./policy";
import type { Topic } from "./topicBank";

export type InterviewQuestionId = "audienceProblem" | "pointOfView" | "talkingPoints" | "evidence" | "story" | "nextAction";

export type FollowUpCondition =
  | "answer-short" // fewer than ~8 words
  | "fewer-than-three-points" // rule 3 needs three distinct points
  | "no-example" // rule 3 / 4 answered abstractly, no concrete example
  | "vague-audience" // rule 1 names no specific person/situation
  | "no-action" // rule 6 gives no concrete next step
  // CP-08 (Sep 24 2026): the GAP phase. Asked only after the six questions are
  // done and only for a piece a script cannot exist without that nothing on
  // file supplies (see evaluateSufficiency). followUpConditions never emits
  // these, so the normal phase is unchanged; they live in each question's
  // followUps array so planInterviewQuestions phrases them per topic for free.
  | "gap-premise"
  | "gap-stance"
  | "gap-points";

/** The three gap conditions, in the order they are asked. */
export const GAP_CONDITIONS: readonly FollowUpCondition[] = ["gap-premise", "gap-stance", "gap-points"];
export const isGapCondition = (c: string | null | undefined): boolean => !!c && (GAP_CONDITIONS as readonly string[]).includes(c);
/** "A small number of targeted gap questions" (Jordan, Sep 24): two at most, then the interview is done either way. */
export const MAX_GAP_QUESTIONS = 2;

export type InterviewQuestion = {
  id: InterviewQuestionId;
  order: number;
  /** Spec §6 question rule, verbatim. */
  rule: string;
  /** What the answer feeds in the generator input. */
  captures: string;
  /** Prompt template; {{topic}} / {{pillar}} / {{client}} are filled by the caller. Illustrative, per-topic wording is the AI's job. */
  template: string;
  substantive: boolean;
  skippable: true;
  allowDontKnow: true;
  followUps: { when: FollowUpCondition; ask: string }[];
  /** Gap kind + wording when the question ends unanswered. `null` = no gap (rule 5 is optional by design). */
  gapWhenMissing: { kind: Gap["kind"]; text: string } | null;
};

export const INTERVIEW_QUESTION_PLAN: readonly InterviewQuestion[] = [
  {
    id: "audienceProblem",
    order: 1,
    rule: "Establish the audience's problem, misconception, or opportunity.",
    captures: "The hook's premise: the specific concern, misconception or surprising observation the viewer recognises.",
    template: "For “{{topic}}” — what do {{audience}} usually get wrong, worry about, or miss here?",
    substantive: true,
    skippable: true,
    allowDontKnow: true,
    followUps: [
      { when: "vague-audience", ask: "Who exactly runs into this — a seller in a particular situation, a first-time buyer, someone relocating?" },
      { when: "answer-short", ask: "Can you say a little more about what that looks like when it happens?" },
      { when: "gap-premise", ask: "In a sentence or two: what do people usually get wrong about “{{topic}}”, or worry about?" },
    ],
    gapWhenMissing: { kind: "missing-answer", text: "The audience's problem or misconception for this topic was not supplied — the hook has no premise from the client." },
  },
  {
    id: "pointOfView",
    order: 2,
    rule: "Ask for the client's point of view in their own words.",
    captures: "The stance the script defends — the client's own wording drives the voice.",
    template: "What's your honest take on that? Say it the way you'd say it to a client sitting across from you.",
    substantive: true,
    skippable: true,
    allowDontKnow: true,
    followUps: [
      { when: "answer-short", ask: "If you had to put that in one strong sentence, what would it be?" },
      { when: "gap-stance", ask: "What's the one thing you'd want someone to believe about “{{topic}}” after watching? Say it the way you would to a client." },
    ],
    gapWhenMissing: { kind: "missing-answer", text: "No point of view in the client's own words — the script's stance would be invented." },
  },
  {
    id: "talkingPoints",
    order: 3,
    rule: "Gather three distinct useful talking points through examples or practical explanation.",
    captures: "The three talking points (re-hook, build up, payoff) — each grounded in an example or practical explanation.",
    template: "Walk me through it: what's the first thing you'd explain, then what, and where does it land?",
    substantive: true,
    skippable: true,
    allowDontKnow: true,
    followUps: [
      { when: "fewer-than-three-points", ask: "That's a strong point. What's another angle or consideration that usually comes up?" },
      { when: "no-example", ask: "Can you give a concrete example — a situation you've actually seen — that shows this?" },
      { when: "gap-points", ask: "Give me three things you'd tell a client about “{{topic}}”, one line each." },
    ],
    gapWhenMissing: { kind: "missing-answer", text: "Fewer than three distinct talking points were supplied; the missing point(s) must not be invented." },
  },
  {
    id: "evidence",
    order: 4,
    rule: "Ask for genuine experience or evidence that supports credibility. Accept that none may exist.",
    captures: "Credibility: a real experience, a real number the client can stand behind, or an explicit “none”.",
    template: "Is there a real experience or example from your own work that backs this up? It's fine if there isn't one.",
    substantive: true,
    skippable: true,
    allowDontKnow: true,
    followUps: [{ when: "no-example", ask: "No problem. Is there a general pattern you've seen enough times to say confidently, without naming anyone?" }],
    // "Accept that none may exist": no evidence is a recorded fact, not a gap the generator should fill.
    gapWhenMissing: { kind: "unsupported-claim", text: "No supporting experience or evidence was supplied; the script must make no claim of results, numbers or credentials." },
  },
  {
    id: "story",
    order: 5,
    rule: "Explore an engaging story, contrast, demonstration, or visual approach when appropriate.",
    captures: "Entertainment as curiosity, contrast or a visual — never forced humour.",
    template: "Is there a contrast, a before/after, a place, or something we could show on camera that makes this land?",
    substantive: false,
    skippable: true,
    allowDontKnow: true,
    followUps: [],
    gapWhenMissing: null,
  },
  {
    id: "nextAction",
    order: 6,
    rule: "Clarify what the viewer should do next and why that action helps them.",
    captures: "The close (takeaway) and the optional caption CTA.",
    template: "After watching, what should someone do next — and why does that help them, not just you?",
    substantive: true,
    skippable: true,
    allowDontKnow: true,
    followUps: [{ when: "no-action", ask: "If they did just one thing this week because of this video, what should it be?" }],
    gapWhenMissing: { kind: "missing-answer", text: "No next step for the viewer was supplied — the close will be a takeaway only and no CTA will be written." },
  },
];

export type AnswerStatus = "answered" | "skipped" | "dont-know" | "pending";

export type InterviewAnswer = {
  questionId: InterviewQuestionId;
  status: AnswerStatus;
  text: string | null;
  /** Follow-up answers appended in order (the same question id). */
  followUps?: { condition: FollowUpCondition; ask: string; text: string | null; status: AnswerStatus }[];
  /** When the answer was reused from an earlier interview / the client file (spec §6 "Reuse known answers"). */
  reusedFrom?: string | null;
  answeredAt?: string | null;
};

// ---------------------------------------------------------------------------
// Answer analysis (pure heuristics) → adaptive follow-up conditions
// ---------------------------------------------------------------------------

const DONT_KNOW_RE = /^(i )?(don'?t|do not) know\b|^not sure\b|^no idea\b|^n\/a$|^skip$/i;
const EXAMPLE_RE = /\b(for example|for instance|e\.g\.|last (year|month|week)|once|one time|a client|a seller|a buyer|we had|i had|i remember|there was|recently)\b/i;
const ACTION_RE = /\b(call|text|dm|message|reach out|book|schedule|talk to|ask|check|review|start|stop|get|compare|walk|test|list|price|prepare|plan)\b/i;
const SPECIFIC_AUDIENCE_RE = /\b(seller|buyer|owner|homeowner|renter|downsiz|relocat|first[- ]time|move[- ]up|investor|family|couple|landlord|agent|neighbou?r)/i;

export function wordCount(text: string | null | undefined): number {
  return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/** Split a free-text answer into candidate distinct points (sentences / list items / "first… then…"). */
export function splitIntoPoints(text: string | null | undefined): string[] {
  if (!text) return [];
  const byLines = text
    .replace(/\r\n?/g, "\n")
    .replace(/([.!?])\s+(?=[A-Z“"])/g, "$1\n") // sentence ends → line breaks (no lookbehind: ES2017 target)
    .split(/\n+|;\s+|\s+(?:then|second(?:ly)?|third(?:ly)?|next|finally|also|another thing)\b[,:]?\s+/i)
    .map((s) => s.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim())
    .filter((s) => wordCount(s) >= 3);
  // Merge fragments that are near-duplicates of the previous one.
  const out: string[] = [];
  for (const p of byLines) if (!out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p);
  return out;
}

export function isSubstantive(answer: InterviewAnswer | undefined): boolean {
  return !!answer && answer.status === "answered" && !!answer.text && !DONT_KNOW_RE.test(answer.text.trim()) && wordCount(answer.text) >= 2;
}

/** Which follow-up conditions an answer triggers — at most one follow-up is asked per question, the first that applies. */
export function followUpConditions(q: InterviewQuestion, answer: InterviewAnswer | undefined): FollowUpCondition[] {
  if (!isSubstantive(answer)) return [];
  const text = answer!.text!;
  const conds: FollowUpCondition[] = [];
  const words = wordCount(text);
  if (q.id === "talkingPoints") {
    const points = splitIntoPoints(text);
    if (points.length < 3) conds.push("fewer-than-three-points");
    if (!EXAMPLE_RE.test(text)) conds.push("no-example");
  }
  if (q.id === "evidence" && !EXAMPLE_RE.test(text) && !/\b(none|nothing|no\b)/i.test(text)) conds.push("no-example");
  if (q.id === "audienceProblem" && !SPECIFIC_AUDIENCE_RE.test(text)) conds.push("vague-audience");
  if (q.id === "nextAction" && !ACTION_RE.test(text)) conds.push("no-action");
  if (words < 8) conds.push("answer-short");
  return conds.filter((c) => q.followUps.some((f) => f.when === c && !isGapCondition(f.when)));
}

// ---------------------------------------------------------------------------
// SUFFICIENCY (CP-08, Sep 24 2026) — "can a script exist from this?", asked of
// everything we hold, not only of the six main answers.
//
// Until today `ready` read three MAIN answers and nothing else, and the rest of
// the hub read `status === "SUBMITTED"` instead of asking. So an interview with
// every question skipped reached "done", submitted, started the preparation
// clock and was queued for a draft from the topic line alone — the drafting
// sweep breaking its own "never drafts from nothing" rule. At the same time a
// perfectly good call — the client saying the whole thing out loud — counted
// for nothing once they had opened the questions.
//
// The three things a script cannot exist without, and where each may come from:
//   premise  the audience's problem   an answer · the APPROVED topic's audience
//                                     need · a client-spoken call excerpt
//   stance   their point of view      an answer · a client-spoken excerpt of
//                                     twelve words or more
//   points   three distinct points    the answers, topped up with distinct
//                                     client-spoken excerpts of eight words+
// The topic line can supply the premise only: an interview with every answer
// skipped and no call is never ready, because a stance and three points cannot
// come from anything but the client.
// ---------------------------------------------------------------------------

export type SufficiencyField = "premise" | "stance" | "points";
export type SufficiencySource = "answer" | "topic" | "call";

/** What we hold beside the answers. Only CLIENT-spoken excerpts ever count. */
export type SufficiencyContext = {
  /** The approved topic's audience need, or null. The caller decides what counts as approved. */
  topicAudienceNeed: string | null;
  callExcerpts: { speaker: string; text: string }[];
};

export type SufficiencyResult = {
  ready: boolean;
  satisfied: Record<SufficiencyField, SufficiencySource | null>;
  missing: SufficiencyField[];
  /** The talking-point seeds, answers first, then call excerpts. */
  seeds: string[];
  /** How many of the seeds came from the call. */
  seedsFromCall: number;
  /** Words the client typed across the substantive answers. */
  clientWords: number;
};

const FIELD_QUESTION: Record<SufficiencyField, InterviewQuestionId> = { premise: "audienceProblem", stance: "pointOfView", points: "talkingPoints" };
const FIELD_GAP: Record<SufficiencyField, FollowUpCondition> = { premise: "gap-premise", stance: "gap-stance", points: "gap-points" };

const usefulFollowUp = (f: { text: string | null; status: AnswerStatus }) => f.status === "answered" && !!f.text && !DONT_KNOW_RE.test(f.text.trim()) && wordCount(f.text) >= 2;

/**
 * Everything the client said for ONE question: the main answer when it is
 * substantive, plus every answered follow-up. So a gap answer rescues a skipped
 * main question — before this, a follow-up to a skipped question was stored
 * and then thrown away (seeds were read only when the main answer counted).
 */
export function effectiveText(a: InterviewAnswer | undefined): string | null {
  if (!a) return null;
  const parts: string[] = [];
  if (isSubstantive(a)) parts.push(a.text!.trim());
  for (const f of a.followUps ?? []) if (usefulFollowUp(f)) parts.push(f.text!.trim());
  return parts.length ? parts.join("\n") : null;
}

export function evaluateSufficiency(answers: InterviewAnswer[], ctx: SufficiencyContext | null | undefined): SufficiencyResult {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const client = (ctx?.callExcerpts ?? []).filter((e) => e.speaker === "client" && wordCount(e.text) >= 5);
  const premiseText = effectiveText(byId.get("audienceProblem"));
  const stanceText = effectiveText(byId.get("pointOfView"));
  const pointsText = effectiveText(byId.get("talkingPoints"));

  const premise: SufficiencySource | null = premiseText ? "answer" : ctx?.topicAudienceNeed && wordCount(ctx.topicAudienceNeed) >= 3 ? "topic" : client.length ? "call" : null;
  const stance: SufficiencySource | null = stanceText ? "answer" : client.some((e) => wordCount(e.text) >= 12) ? "call" : null;
  const fromAnswers = splitIntoPoints(pointsText);
  const seeds = [...fromAnswers];
  let seedsFromCall = 0;
  for (const e of client) {
    if (seeds.length >= 3) break;
    const t = e.text.trim();
    if (wordCount(t) < 8 || seeds.some((s) => s.toLowerCase() === t.toLowerCase())) continue;
    seeds.push(t);
    seedsFromCall++;
  }
  const points: SufficiencySource | null = seeds.length >= 3 ? (seedsFromCall ? "call" : "answer") : null;
  const satisfied = { premise, stance, points };
  const missing = (["premise", "stance", "points"] as SufficiencyField[]).filter((f) => !satisfied[f]);
  // The stance and the points only ever come from the client (answers or their
  // own words on a call), so "all three" already means topic text alone cannot
  // make an all-skipped interview ready. Stated anyway, because it is the rule.
  const fromClient = stance !== null || points !== null;
  const clientWords = INTERVIEW_QUESTION_PLAN.reduce((n, q) => n + wordCount(effectiveText(byId.get(q.id))), 0);
  return { ready: missing.length === 0 && fromClient, satisfied, missing, seeds, seedsFromCall, clientWords };
}

export type NextStep =
  | { kind: "question"; question: InterviewQuestion; prompt: string }
  | { kind: "follow-up"; question: InterviewQuestion; condition: FollowUpCondition; prompt: string }
  | { kind: "done"; answered: number; skipped: number; substantiveAnswered: number };

export type InterviewContext = {
  topic: Topic;
  audience: string | null;
  clientName: string | null;
  /**
   * PER-TOPIC WORDING (F10). The templates above carry the comment "per-topic
   * wording is the AI's job", and until Sep 22 2026 nothing did that job — every
   * client on every topic read the same six sentences with the title dropped in,
   * which is why "what do people in this situation usually get wrong?" arrived
   * on a topic about pre-listing inspections.
   *
   * Keyed by question id, or `<id>:fu:<condition>` for a follow-up. The house
   * template is the FALLBACK, never replaced: a plan that failed to generate, a
   * key the model omitted, or a phrasing that arrives empty all fall straight
   * back to the sentence that has always worked. The six question ROLES are
   * fixed — assembleScriptInputs depends on them — so this changes how a
   * question is asked and never what is being asked for.
   */
  phrasing?: Record<string, string> | null;
  /**
   * CP-08: what we already hold beside the answers. When given, a finished
   * interview that is still not sufficient gets up to MAX_GAP_QUESTIONS
   * targeted questions — only for what nothing on file supplies, so a premise
   * the approved topic already states is never asked for again. Omitted = the
   * old behaviour exactly (no gap phase).
   */
  sufficiency?: SufficiencyContext | null;
};

/** The stored per-topic sentence for a step, when one exists and is usable. */
function phrased(ctx: InterviewContext, key: string): string | null {
  const v = ctx.phrasing?.[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  // A phrasing that still carries a placeholder was never filled in; a
  // one-word one is not a question. Either way the template is better.
  return t.length >= 12 && !t.includes("{{") ? t : null;
}

function fill(template: string, ctx: InterviewContext): string {
  return template
    .replace(/\{\{topic\}\}/g, ctx.topic.title)
    .replace(/\{\{pillar\}\}/g, ctx.topic.pillarRef.pillarName)
    .replace(/\{\{client\}\}/g, ctx.clientName ?? "you")
    .replace(/\{\{audience\}\}/g, ctx.audience ?? "people in this situation");
}

/**
 * The next thing to ask, or done. Pure: the same answers always give the same
 * step, so an interrupted interview resumes exactly where it stopped.
 * A follow-up is asked at most once per question and only when its condition
 * applies; skipped / don't-know answers move on without a follow-up.
 */
export function nextQuestion(answers: InterviewAnswer[], ctx: InterviewContext): NextStep {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  for (const q of INTERVIEW_QUESTION_PLAN) {
    const a = byId.get(q.id);
    if (!a || a.status === "pending") return { kind: "question", question: q, prompt: phrased(ctx, q.id) ?? fill(q.template, ctx) };
    if (a.status === "skipped" || a.status === "dont-know") continue;
    const asked = new Set((a.followUps ?? []).map((f) => f.condition));
    const pendingFollowUp = (a.followUps ?? []).find((f) => f.status === "pending");
    if (pendingFollowUp) return { kind: "follow-up", question: q, condition: pendingFollowUp.condition, prompt: phrased(ctx, `${q.id}:fu:${pendingFollowUp.condition}`) ?? fill(pendingFollowUp.ask, ctx) };
    if (asked.size) continue; // one follow-up per question
    const cond = followUpConditions(q, a)[0];
    if (cond) {
      const fu = q.followUps.find((f) => f.when === cond)!;
      return { kind: "follow-up", question: q, condition: cond, prompt: phrased(ctx, `${q.id}:fu:${cond}`) ?? fill(fu.ask, ctx) };
    }
  }
  // THE GAP PHASE (CP-08). Every question has been answered or skipped. If a
  // script still cannot exist from what we hold, ask for the first missing
  // piece — once each, two at most — and then stop: the interview is done
  // either way, and "not sufficient" is a state the rest of the hub now reads.
  if (ctx.sufficiency) {
    const suff = evaluateSufficiency(answers, ctx.sufficiency);
    const gapsAsked = answers.reduce((n, a) => n + (a.followUps ?? []).filter((f) => isGapCondition(f.condition)).length, 0);
    if (!suff.ready && gapsAsked < MAX_GAP_QUESTIONS) {
      for (const field of suff.missing) {
        const q = INTERVIEW_QUESTION_PLAN.find((x) => x.id === FIELD_QUESTION[field])!;
        const cond = FIELD_GAP[field];
        if ((byId.get(q.id)?.followUps ?? []).some((f) => f.condition === cond)) continue;
        const fu = q.followUps.find((f) => f.when === cond)!;
        return { kind: "follow-up", question: q, condition: cond, prompt: phrased(ctx, `${q.id}:fu:${cond}`) ?? fill(fu.ask, ctx) };
      }
    }
  }
  const answered = answers.filter((a) => a.status === "answered").length;
  const skipped = answers.filter((a) => a.status === "skipped" || a.status === "dont-know").length;
  const substantiveAnswered = INTERVIEW_QUESTION_PLAN.filter((q) => q.substantive && isSubstantive(byId.get(q.id))).length;
  return { kind: "done", answered, skipped, substantiveAnswered };
}

// ---------------------------------------------------------------------------
// Answers → generator input
// ---------------------------------------------------------------------------

export type ScriptGeneratorInput = {
  stamp: PolicyStamp;
  topic: {
    id: string | null;
    /** Owning client — prompts.ts refuses a topic from another client on this path too. */
    clientId: string | null;
    title: string;
    description: string | null;
    pillarName: string;
    pillarId: string | null;
    audienceNeed: string | null;
    businessGoal: string | null;
    intendedMessage: string | null;
  };
  answers: Record<InterviewQuestionId, { status: AnswerStatus; text: string | null; followUpText: string | null; reusedFrom: string | null }>;
  /** Candidate talking points split from rule 3 (+ its follow-up); the generator must not add a fourth or invent a third. */
  talkingPointSeeds: string[];
  /** Whether the client supplied any experience / evidence. False = no results, numbers or credentials may be claimed. */
  evidenceSupplied: boolean;
  /** Rule 5 material, or null — never forced. */
  storyOrVisual: string | null;
  /** Rule 6: what the viewer should do and why; null = takeaway-only close, no CTA. */
  viewerNextStep: string | null;
  gaps: Gap[];
  /** The interview's own completeness, for the reviewer. */
  completeness: { substantiveAnswered: number; substantiveTotal: number; ready: boolean };
  /** CP-08: where each essential piece came from (answer / approved topic / call), and what is still missing. */
  sufficiency?: SufficiencyResult;
};

export function assembleScriptInputs(answers: InterviewAnswer[], topic: Topic, strategyVersion: string | null, suffCtx?: SufficiencyContext | null): ScriptGeneratorInput {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const gaps: Gap[] = [];
  const rec = {} as ScriptGeneratorInput["answers"];
  // ONE sufficiency reading for readiness, seeds and gaps, so the reviewer, the
  // client and the drafting sweep cannot disagree about the same answers.
  const suff = evaluateSufficiency(answers, suffCtx ?? null);
  const coveredElsewhere = new Set<InterviewQuestionId>(
    (Object.entries(suff.satisfied) as [SufficiencyField, SufficiencySource | null][])
      .filter(([, src]) => src === "topic" || src === "call")
      .map(([f]) => FIELD_QUESTION[f]),
  );

  for (const q of INTERVIEW_QUESTION_PLAN) {
    const a = byId.get(q.id);
    const followUpText = (a?.followUps ?? [])
      .filter((f) => f.status === "answered" && f.text)
      .map((f) => f.text as string)
      .join("\n");
    rec[q.id] = { status: a?.status ?? "pending", text: a?.text ?? null, followUpText: followUpText || null, reusedFrom: a?.reusedFrom ?? null };
    // A gap answer to a skipped question is still the client's answer.
    const substantive = isSubstantive(a) || !!(a && (a.followUps ?? []).some(usefulFollowUp));
    // Covered by the approved topic or the client's own words on the call: not
    // a gap the client is told about, and not one the writer must leave empty.
    if (!substantive && q.gapWhenMissing && !coveredElsewhere.has(q.id)) {
      const why = !a || a.status === "pending" ? "not asked" : a.status === "skipped" ? "skipped" : a.status === "dont-know" ? "answered “I don't know”" : "answer too thin";
      gaps.push(makeGap(q.gapWhenMissing.kind, `${q.gapWhenMissing.text} (${why})`, { field: q.id, question: q.template }));
    }
  }

  // Talking-point seeds: rule 3 + its follow-ups (a gap answer included), then
  // distinct client-spoken call excerpts when the answers stop short of three.
  const seeds = suff.seeds;
  if (seeds.length && seeds.length < 3) {
    gaps.push(
      makeGap("missing-answer", `Only ${seeds.length} distinct talking point${seeds.length === 1 ? "" : "s"} could be read from the answers; the script needs exactly three and the rest must come from the client, not the generator.`, {
        field: "talkingPoints",
        question: INTERVIEW_QUESTION_PLAN[2].followUps[0].ask,
      }),
    );
  }

  const evidence = byId.get("evidence");
  const evidenceSupplied = isSubstantive(evidence) && !/^(none|nothing|no\b|not really)/i.test(evidence!.text!.trim());
  const story = byId.get("story");
  const next = byId.get("nextAction");

  const substantiveTotal = INTERVIEW_QUESTION_PLAN.filter((q) => q.substantive).length;
  const substantiveAnswered = INTERVIEW_QUESTION_PLAN.filter((q) => q.substantive && isSubstantive(byId.get(q.id))).length;
  // Ready = the three things a script cannot exist without: a premise, a point
  // of view, and ≥3 points — read by evaluateSufficiency (answers, gap answers,
  // the approved topic and the client's own words on the call).
  const ready = suff.ready;

  return {
    stamp: { ...policyStamp(strategyVersion), policyVersion: GENERATION_POLICY_VERSION },
    topic: {
      id: topic.id,
      clientId: topic.clientId,
      title: topic.title,
      description: topic.description,
      pillarName: topic.pillarRef.pillarName,
      pillarId: topic.pillarRef.pillarId,
      audienceNeed: topic.audienceNeed,
      businessGoal: topic.businessGoal,
      intendedMessage: topic.intendedMessage,
    },
    answers: rec,
    talkingPointSeeds: seeds,
    evidenceSupplied,
    storyOrVisual: isSubstantive(story) ? story!.text : null,
    viewerNextStep: isSubstantive(next) ? next!.text : null,
    gaps,
    completeness: { substantiveAnswered, substantiveTotal, ready },
    sufficiency: suff,
  };
}
