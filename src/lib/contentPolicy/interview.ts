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
  | "no-action"; // rule 6 gives no concrete next step

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
    followUps: [{ when: "answer-short", ask: "If you had to put that in one strong sentence, what would it be?" }],
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
  return conds.filter((c) => q.followUps.some((f) => f.when === c));
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
};

export function assembleScriptInputs(answers: InterviewAnswer[], topic: Topic, strategyVersion: string | null): ScriptGeneratorInput {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const gaps: Gap[] = [];
  const rec = {} as ScriptGeneratorInput["answers"];

  for (const q of INTERVIEW_QUESTION_PLAN) {
    const a = byId.get(q.id);
    const followUpText = (a?.followUps ?? [])
      .filter((f) => f.status === "answered" && f.text)
      .map((f) => f.text as string)
      .join("\n");
    rec[q.id] = { status: a?.status ?? "pending", text: a?.text ?? null, followUpText: followUpText || null, reusedFrom: a?.reusedFrom ?? null };
    const substantive = isSubstantive(a);
    if (!substantive && q.gapWhenMissing) {
      const why = !a || a.status === "pending" ? "not asked" : a.status === "skipped" ? "skipped" : a.status === "dont-know" ? "answered “I don't know”" : "answer too thin";
      gaps.push(makeGap(q.gapWhenMissing.kind, `${q.gapWhenMissing.text} (${why})`, { field: q.id, question: q.template }));
    }
  }

  // Talking-point seeds from rule 3 + follow-up.
  const tpAnswer = byId.get("talkingPoints");
  const seeds = isSubstantive(tpAnswer) ? splitIntoPoints([tpAnswer!.text, rec.talkingPoints.followUpText].filter(Boolean).join("\n")) : [];
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
  // Ready = the three things a script cannot exist without: a premise, a point of view, and ≥3 points.
  const ready = isSubstantive(byId.get("audienceProblem")) && isSubstantive(byId.get("pointOfView")) && seeds.length >= 3;

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
  };
}
