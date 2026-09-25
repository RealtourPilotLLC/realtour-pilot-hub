import "server-only";
import { prisma } from "@/lib/prisma";
import { activePolicyVersion, sha256 } from "@/lib/aiRuns";
import { approvedStrategy } from "@/lib/contentStrategy";
import { listPillars } from "@/lib/contentPillars";
import {
  INTERVIEW_QUESTION_PLAN, nextQuestion, assembleScriptInputs, evaluateSufficiency, isGapCondition,
  type InterviewAnswer, type InterviewQuestionId, type NextStep, type ScriptGeneratorInput, type Topic, type FollowUpCondition,
  type SufficiencyContext, type SufficiencyResult, type SourceExcerpt,
} from "@/lib/contentPolicy";
import { safeTopicExcerpts, type TopicExcerpt } from "@/lib/contentTopics";

// ---------------------------------------------------------------------------
// The guided topic interview (spec §6) — the policy's question plan
// (src/lib/contentPolicy/interview.ts) wired to rows. One ContentInterview
// per topic+month (Postgres-unique). Every answer is a NEW
// ContentInterviewAnswer row that supersedes the last one for that question,
// so an edit never erases what was said, and a script version can name the
// exact answer rows it was built from.
//
// The interview is resumable by construction: nextQuestion() is pure over
// the stored answers, so the same rows always give the same next step.
// ---------------------------------------------------------------------------

// CP-08 (Sep 24 2026): "done" is no longer "enough". An interview whose
// answers cannot carry a script is NEEDS_FOLLOWUP (with up to two targeted gap
// questions first), and sending it anyway is SUBMITTED_WITH_GAPS — a state no
// reader mistakes for SUBMITTED: no submittedAt, no preparation clock, no
// auto-draft, and a Kyle task to follow up. SUBMITTED now means what the rest
// of the hub always assumed it meant: the answers are sufficient.

/** Statuses interviewState never overwrites on a re-render. */
const STICKY = new Set(["SUBMITTED", "SUBMITTED_WITH_GAPS", "ABANDONED"]);

const ROLE_OF: Record<InterviewQuestionId, string> = {
  audienceProblem: "AUDIENCE_PROBLEM", pointOfView: "POINT_OF_VIEW", talkingPoints: "TALKING_POINT", evidence: "EVIDENCE", story: "STORY", nextAction: "NEXT_STEP",
};
const QUESTION_IDS = new Set<string>(INTERVIEW_QUESTION_PLAN.map((q) => q.id));
const followUpKey = (qid: InterviewQuestionId, cond: FollowUpCondition) => `${qid}:fu:${cond}`;

/**
 * 6.5 (Sep 25 2026): an interview opened for a topic the client already talked
 * through on a call is a CALL interview — it asks only what the call left
 * missing (GAPS_ONLY) instead of the six questions from the top. A caller that
 * knows better passes `sourceKind`; otherwise it is CALL when R01's one
 * planning reader says the month is on the CALL route, the call has been HELD,
 * and the client's own words about this topic (confidential-scrubbed) exist.
 * Anything unreadable stays WRITTEN — the full questionnaire is never wrong,
 * only longer.
 */
export async function getOrCreateInterview(topicId: string, monthId: string, actor: { staffUserId?: string | null; clientUserId?: string | null }, opts: { sourceKind?: "WRITTEN" | "CALL" } = {}): Promise<string> {
  const existing = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId, monthId } }, select: { id: true } });
  if (existing) return existing.id;
  const [t, m] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, clientId: true } }),
    prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true } }),
  ]);
  if (!t || !m) throw new Error("Topic or month not found.");
  if (t.enrollmentId !== m.enrollmentId) throw new Error("That month belongs to another client.");
  const sourceKind = opts.sourceKind ?? (await callRouteWithWords(topicId, monthId, t.clientId) ? "CALL" : "WRITTEN");
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(t.enrollmentId)]);
  try {
    const row = await prisma.contentInterview.create({
      data: {
        topicId, monthId, enrollmentId: t.enrollmentId, clientId: t.clientId, strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id,
        sourceKind, status: "NOT_STARTED", questionPlanJson: JSON.stringify(INTERVIEW_QUESTION_PLAN.map((q) => ({ key: q.id, role: ROLE_OF[q.id], text: q.template }))),
        startedByClientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? null, lastActivityAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    const again = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId, monthId } }, select: { id: true } });
    if (again) return again.id;
    throw new Error("Could not start the interview.");
  }
}

/** The month is on the call route, its call was held, and the client talked about this topic on it. */
async function callRouteWithWords(topicId: string, monthId: string, clientId: string): Promise<boolean> {
  const facts = await import("@/lib/planningFacts").then((m) => m.planningForMonth(monthId)).catch(() => null);
  if (!facts || facts.route !== "CALL" || facts.call !== "HELD") return false;
  const { kept } = await safeTopicExcerpts(topicId, monthId, clientId).catch(() => ({ kept: [] as TopicExcerpt[] }));
  return kept.some((e) => e.speaker === "client" && e.text.trim().split(/\s+/).length >= 5);
}

/** The live (non-superseded) answer rows, newest version per question key. */
export async function currentAnswers(interviewId: string) {
  const rows = await prisma.contentInterviewAnswer.findMany({ where: { interviewId }, orderBy: [{ questionKey: "asc" }, { version: "desc" }] });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.questionKey) ? false : (seen.add(r.questionKey), true)));
}

async function topicForInterview(interviewId: string): Promise<{ topic: Topic; audience: string | null; clientName: string | null; row: NonNullable<Awaited<ReturnType<typeof prisma.contentInterview.findUnique>>>; sufficiency: SufficiencyContext; excerpts: TopicExcerpt[]; mode: "FULL" | "GAPS_ONLY" }> {
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId } });
  if (!row) throw new Error("Interview not found.");
  const [t, client, strategy, pillars, safe] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: row.topicId } }),
    prisma.client.findUnique({ where: { id: row.clientId }, select: { name: true } }),
    approvedStrategy(row.enrollmentId),
    listPillars(row.enrollmentId, { includeRetired: true }),
    safeTopicExcerpts(row.topicId, row.monthId, row.clientId),
  ]);
  if (!t) throw new Error("Topic not found.");
  // U01: no invented name. "(no pillar)" used to reach the script prompt, come
  // back as the script's category and show on a client's card; an empty name
  // leaves the category to the strategy, and the validator reports
  // pillar.missing (overridable with a note) instead.
  const pillarName = pillars.find((p) => p.id === t.pillarId)?.name ?? t.pillar ?? "";
  const topic: Topic = {
    id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage,
    source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: row.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: strategy?.label ?? null, stamp: null,
  };
  // 6.5: a CALL interview asks only the gaps (see getOrCreateInterview).
  const mode = row.sourceKind === "CALL" ? "GAPS_ONLY" : "FULL";
  return { topic, audience: strategy?.document?.targetAudience.primaryClientTypes ?? null, clientName: client?.name ?? null, row, sufficiency: sufficiencyContextFor(t, safe.kept), excerpts: safe.kept, mode };
}

/**
 * What counts beside the answers (CP-08). The topic's audience need counts only
 * when a person stands behind it — Jordan approved the topic, or staff/an
 * import wrote it — because an unreviewed AI or call topic's audience line is a
 * guess, and "never ask for facts already in approved context" is about
 * APPROVED context. Excerpts are the confidential-scrubbed ones only.
 */
function sufficiencyContextFor(t: { audienceNeed: string | null; approvalState: string | null; source: string }, excerpts: TopicExcerpt[]): SufficiencyContext {
  const approved = t.approvalState === "APPROVED" || t.source === "staff" || t.source === "import";
  return { topicAudienceNeed: approved ? t.audienceNeed : null, callExcerpts: excerpts.map((e) => ({ speaker: e.speaker, text: e.text })) };
}

/**
 * The per-topic wording stored on the interview (F10), or null.
 *
 * Shape-tolerant on purpose. `getOrCreateInterview` has always written
 * questionPlanJson as `[{key, role, text}]` with the RAW `{{topic}}` template
 * in `text` — so every existing row parses here and every one of them is
 * correctly rejected by `phrased()`'s placeholder check. A generated plan
 * writes the same array with real sentences and the follow-up keys alongside.
 */
function storedPhrasing(questionPlanJson: string | null | undefined): Record<string, string> | null {
  if (!questionPlanJson) return null;
  try {
    const v: unknown = JSON.parse(questionPlanJson);
    if (!Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const row of v) {
      const key = (row as { key?: unknown }).key;
      const text = (row as { text?: unknown }).text;
      if (typeof key === "string" && typeof text === "string") out[key] = text;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** Rows → the policy's answer shape (follow-ups fold under their question). */
function toPolicyAnswers(rows: Awaited<ReturnType<typeof currentAnswers>>): InterviewAnswer[] {
  const out = new Map<InterviewQuestionId, InterviewAnswer>();
  for (const r of rows) {
    if (!QUESTION_IDS.has(r.questionKey)) continue;
    const qid = r.questionKey as InterviewQuestionId;
    out.set(qid, { questionId: qid, status: r.answerKind === "SKIPPED" ? "skipped" : r.answerKind === "DONT_KNOW" ? "dont-know" : r.answerText?.trim() ? "answered" : "pending", text: r.answerText, followUps: [], reusedFrom: r.reusedFromAnswerId, answeredAt: r.answeredAt.toISOString() });
  }
  for (const r of rows) {
    const m = /^([a-zA-Z]+):fu:(.+)$/.exec(r.questionKey);
    if (!m) continue;
    const a = out.get(m[1] as InterviewQuestionId);
    if (!a) continue;
    a.followUps!.push({ condition: m[2] as FollowUpCondition, ask: r.questionText, text: r.answerText, status: r.answerKind === "SKIPPED" ? "skipped" : r.answerKind === "DONT_KNOW" ? "dont-know" : r.answerText?.trim() ? "answered" : "pending" });
  }
  return [...out.values()];
}

export type InterviewState = {
  interviewId: string; status: string; answeredCount: number; next: NextStep;
  sufficiency: {
    ready: boolean; substantiveAnswered: number; substantiveTotal: number; gaps: { kind: string; field: string | null; text: string; question: string | null }[];
    /** CP-08: where the premise / stance / points came from, what is missing, and how many seeds are the client's words on the call. */
    satisfied: SufficiencyResult["satisfied"]; missing: SufficiencyResult["missing"]; seedsFromCall: number;
  };
  answers: { questionKey: string; questionText: string; answerText: string | null; answerKind: string; version: number; answeredAt: string }[];
  /** The stored key the next step writes to (question id, or "<id>:fu:<condition>"). */
  nextKey: string | null;
  /** The next step is a targeted gap question (CP-08), not one of the six. */
  nextIsGap: boolean;
  /** 6.5: GAPS_ONLY when the call already covered this topic — only what is missing is asked. */
  mode: "FULL" | "GAPS_ONLY";
};

/** The sufficiencyJson every writer stores — one shape. */
const sufficiencyJson = (suff: SufficiencyResult, gaps: { text: string }[]) =>
  JSON.stringify({ sufficient: suff.ready, missing: gaps.map((g) => g.text), fields: suff.missing, satisfied: suff.satisfied, seedsFromCall: suff.seedsFromCall });

/** Where the interview stands: the next question (or done), completeness, and the answers so far. Pure over the rows; safe to call on every render. */
export async function interviewState(interviewId: string, opts: { readOnly?: boolean } = {}): Promise<InterviewState> {
  const { topic, audience, clientName, row, sufficiency, mode } = await topicForInterview(interviewId);
  const rows = await currentAnswers(interviewId);
  const answers = toPolicyAnswers(rows);
  const next = nextQuestion(answers, { topic, audience, clientName, phrasing: storedPhrasing(row.questionPlanJson), sufficiency, mode });
  const inputs = assembleScriptInputs(answers, topic, row.strategyVersionId, sufficiency);
  const suff = inputs.sufficiency!;
  const nextKey = next.kind === "question" ? next.question.id : next.kind === "follow-up" ? followUpKey(next.question.id, next.condition) : null;
  const nextIsGap = next.kind === "follow-up" && isGapCondition(next.condition);
  const status = next.kind === "done" ? (suff.ready ? "SUFFICIENT" : "NEEDS_FOLLOWUP") : rows.length ? "IN_PROGRESS" : "NOT_STARTED";
  const data: Record<string, unknown> = {};
  if (row.status !== status && !STICKY.has(row.status)) {
    Object.assign(data, { status, currentQuestionKey: nextKey, answeredCount: rows.filter((r) => r.answerKind !== "SKIPPED").length, sufficiencyJson: sufficiencyJson(suff, inputs.gaps), sufficientAt: suff.ready ? new Date() : null });
  }
  // The first time a gap question is SERVED, stamp it: Kyle's follow-up clock
  // (two business days) runs from here, not from the client's last keystroke.
  if (nextIsGap && !row.gapQuestionsAskedAt) data.gapQuestionsAskedAt = new Date();
  if (Object.keys(data).length && !opts.readOnly) await prisma.contentInterview.update({ where: { id: interviewId }, data }).catch(() => {});
  return {
    interviewId, status: STICKY.has(row.status) ? row.status : status, answeredCount: rows.length, next, nextKey, nextIsGap, mode,
    sufficiency: { ready: suff.ready, substantiveAnswered: inputs.completeness.substantiveAnswered, substantiveTotal: inputs.completeness.substantiveTotal, gaps: inputs.gaps, satisfied: suff.satisfied, missing: suff.missing, seedsFromCall: suff.seedsFromCall },
    answers: rows.map((r) => ({ questionKey: r.questionKey, questionText: r.questionText, answerText: r.answerText, answerKind: r.answerKind, version: r.version, answeredAt: r.answeredAt.toISOString() })),
  };
}

/**
 * Sufficiency as a pure READ — no status write, no stamp. The drafting sweep
 * asks this of every interview it considers, on every render of the month, so
 * it must not be the thing that moves an interview's status.
 */
export async function readInterviewSufficiency(interviewId: string): Promise<SufficiencyResult> {
  const { row, sufficiency } = await topicForInterview(interviewId);
  const answers = toPolicyAnswers(await currentAnswers(row.id));
  return evaluateSufficiency(answers, sufficiency);
}

/**
 * Answer (or skip / "don't know") one question. Always a NEW row: version n+1
 * with supersedesId → the previous row, so no edit can erase an answer and a
 * script that cited the old row still points at exactly what it read.
 */
export async function answerQuestion(interviewId: string, questionKey: string, input: { text?: string | null; kind: "TYPED" | "SKIPPED" | "DONT_KNOW"; actor: { staffUserId?: string | null; clientUserId?: string | null }; questionText?: string | null; /** CP-08: the suggested answer the person started from. Re-resolved here — the browser's copy of it is never trusted. */ suggestionId?: string | null }): Promise<{ answerId: string; version: number }> {
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, status: true } });
  if (!row) throw new Error("Interview not found.");
  if (row.status === "SUBMITTED" || row.status === "SUBMITTED_WITH_GAPS") {
    // Answers after submission are allowed (they produce a NEW draft), but the
    // interview steps back to IN_PROGRESS so the state is honest — and a
    // "sent with gaps" note does not outlive the gap being answered.
    await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "IN_PROGRESS", submittedAt: null, sentWithGapsAt: null, sentWithGapsByClientUserId: null } });
  }
  const m = /^([a-zA-Z]+)(?::fu:(.+))?$/.exec(questionKey);
  if (!m || !QUESTION_IDS.has(m[1])) throw new Error("Unknown question.");
  const q = INTERVIEW_QUESTION_PLAN.find((x) => x.id === m[1])!;
  const isFollowUp = !!m[2];
  // The stored question is the one the person actually saw: the caller's
  // phrasing when given, else the house template filled for this topic (never
  // the raw {{topic}} placeholders).
  let questionText = input.questionText?.trim() || "";
  if (!questionText) {
    const { topic, audience, clientName, row: full } = await topicForInterview(interviewId);
    // The per-topic sentence when one was generated; the house template else.
    const stored = storedPhrasing(full.questionPlanJson)?.[questionKey]?.trim();
    if (stored && stored.length >= 12 && !stored.includes("{{")) {
      questionText = stored;
    } else {
      const raw = isFollowUp ? q.followUps.find((f) => f.when === m[2])?.ask ?? q.template : q.template;
      questionText = raw.replace(/\{\{topic\}\}/g, topic.title).replace(/\{\{pillar\}\}/g, topic.pillarRef.pillarName).replace(/\{\{client\}\}/g, clientName ?? "you").replace(/\{\{audience\}\}/g, audience ?? "people in this situation");
    }
  }
  const prev = await prisma.contentInterviewAnswer.findFirst({ where: { interviewId, questionKey }, orderBy: { version: "desc" }, select: { id: true, version: true } });
  const text = input.kind === "TYPED" ? (input.text ?? "").trim().slice(0, 8000) : null;
  if (input.kind === "TYPED" && !text) throw new Error("Type an answer, or skip the question.");
  // A suggested answer used AS IS is the client's own words from the call:
  // EXTRACTED, with the call and the excerpt it came from. Edited, it is their
  // typed answer, and the row says which suggestion it started from.
  let provenance: { answerKind: string; callRecordId: string | null; excerptJson: string | null; flagsJson: string | null } | null = null;
  if (input.kind === "TYPED" && input.suggestionId) {
    const sug = (await suggestedAnswersFor(interviewId)).find((x) => x.id === input.suggestionId) ?? null;
    if (sug && sug.kind === "profile") {
      provenance = { answerKind: "TYPED", callRecordId: null, excerptJson: null, flagsJson: JSON.stringify({ basedOnSuggestion: { id: sug.id, factId: sug.provenance.factId ?? null, source: "profile" } }) };
    } else if (sug) {
      const verbatim = sug.text.replace(/\s+/g, " ").trim() === (text ?? "").replace(/\s+/g, " ").trim();
      provenance = verbatim
        ? { answerKind: "EXTRACTED", callRecordId: sug.provenance.callRecordId, excerptJson: JSON.stringify([{ time: sug.provenance.time, speaker: "client", text: sug.text }]), flagsJson: null }
        : { answerKind: "TYPED", callRecordId: null, excerptJson: null, flagsJson: JSON.stringify({ basedOnSuggestion: { id: sug.id, callRecordId: sug.provenance.callRecordId, source: sug.provenance.source } }) };
    }
  }
  const created = await prisma.contentInterviewAnswer.create({
    data: {
      interviewId, questionKey, questionRole: isFollowUp ? "FOLLOWUP" : ROLE_OF[q.id], questionText, answerText: text, answerKind: provenance?.answerKind ?? input.kind,
      sourceKind: input.actor.clientUserId ? "CLIENT" : "STAFF", clientUserId: input.actor.clientUserId ?? null, staffUserId: input.actor.staffUserId ?? null,
      version: (prev?.version ?? 0) + 1, supersedesId: prev?.id ?? null,
      ...(provenance ? { callRecordId: provenance.callRecordId, excerptJson: provenance.excerptJson, flagsJson: provenance.flagsJson, speaker: provenance.answerKind === "EXTRACTED" ? "client" : null } : {}),
    },
    select: { id: true, version: true },
  });
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { lastActivityAt: new Date(), status: "IN_PROGRESS" } });
  await interviewState(interviewId); // recompute status/sufficiency
  return { answerId: created.id, version: created.version };
}

/**
 * The generator input plus the ids of the exact answer rows it was built from,
 * and (CP-08) the call's scrubbed excerpts for this topic — so a topic chosen
 * on a call is scripted from what the client SAID there, beside whatever they
 * typed, and nobody retypes the call as answers.
 */
export async function assembleInterviewInputs(interviewId: string): Promise<{ input: ScriptGeneratorInput; answerIds: string[]; topic: Topic; enrollmentId: string; clientId: string; monthId: string; strategyVersionId: string | null; policyVersionId: string | null; excerpts: SourceExcerpt[] }> {
  const { topic, row, sufficiency, excerpts } = await topicForInterview(interviewId);
  const rows = await currentAnswers(interviewId);
  const input = assembleScriptInputs(toPolicyAnswers(rows), topic, row.strategyVersionId, sufficiency);
  const plain: SourceExcerpt[] = excerpts.map((e) => ({ speaker: e.speaker, speakerName: e.speakerName, source: e.source, text: e.text }));
  return { input, answerIds: rows.map((r) => r.id), topic, enrollmentId: row.enrollmentId, clientId: row.clientId, monthId: row.monthId, strategyVersionId: row.strategyVersionId, policyVersionId: row.policyVersionId, excerpts: plain };
}

export type SubmitOutcome = { status: "SUBMITTED" | "SUBMITTED_WITH_GAPS"; missing: string[] };

/**
 * Send the answers. SUBMITTED only when they are sufficient (CP-08) — before
 * this, finishing the sequence was enough, so six skipped questions submitted,
 * started the preparation clock and queued a draft from nothing.
 *
 * Not sufficient: refused, unless the client explicitly chooses to send what
 * they have (`acknowledgeGaps`). That is SUBMITTED_WITH_GAPS — recorded with
 * who and when, NO submittedAt (so nothing counts it as done), and Kyle gets a
 * task to follow up. Their progress is kept either way.
 */
export async function submitInterview(interviewId: string, actor: { staffUserId?: string | null; clientUserId?: string | null }, opts: { acknowledgeGaps?: boolean } = {}): Promise<SubmitOutcome> {
  const st = await interviewState(interviewId);
  if (st.next.kind !== "done") throw new Error("There is still a question to answer (or skip) before submitting.");
  const missing = st.sufficiency.gaps.map((g) => g.text);
  const json = JSON.stringify({ sufficient: st.sufficiency.ready, missing, fields: st.sufficiency.missing, satisfied: st.sufficiency.satisfied, seedsFromCall: st.sufficiency.seedsFromCall });
  if (st.sufficiency.ready) {
    await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "SUBMITTED", submittedAt: new Date(), submittedByClientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? undefined, sufficiencyJson: json, sentWithGapsAt: null, sentWithGapsByClientUserId: null } });
    const { closeAnswerGapTask } = await import("@/lib/programDeskTasks");
    await closeAnswerGapTask(interviewId).catch(() => {});
    return { status: "SUBMITTED", missing: [] };
  }
  const left = st.sufficiency.missing.length;
  if (!opts.acknowledgeGaps) throw new Error(`Not enough to write this one yet — ${left} thing${left === 1 ? "" : "s"} still missing. Answer what you can, or send what you have and we'll follow up.`);
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "SUBMITTED_WITH_GAPS", submittedAt: null, sentWithGapsAt: new Date(), sentWithGapsByClientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? undefined, sufficiencyJson: json } });
  const { openAnswerGapTask } = await import("@/lib/programDeskTasks");
  await openAnswerGapTask(interviewId, "SENT_WITH_GAPS").catch(() => {});
  return { status: "SUBMITTED_WITH_GAPS", missing };
}

// ---------------------------------------------------------------------------
// SUGGESTED ANSWERS FROM THE CALL (CP-08). What the client already said about
// this topic on an approved planning call, offered beside a question as an
// optional, editable starting point with its source shown. Client-spoken
// lines only (a hypothetical Jordan floated is not the client's experience),
// and only after the confidentiality scrub: a [CONFIDENTIAL] mark, an overlap
// with a confidential fact, or another enrolled client's name drops the line.
// ---------------------------------------------------------------------------

export type SuggestedAnswer = {
  id: string; text: string;
  /** "call": their own words on a planning call. "profile" (6.5): an accepted note on their file, in their own words. */
  kind?: "call" | "profile";
  provenance: { callRecordId: string | null; callDateISO: string | null; time: string | null; source: string; factId?: string | null };
};

/**
 * 6.5 (Sep 25 2026): what the client's file already holds about this topic,
 * offered as an optional, editable starting point beside the call's lines.
 * Deliberately narrow, because a fact is usually a staff paraphrase and a
 * suggestion puts words in front of the client:
 *   · accepted, AI-allowed, never confidential (marker, flag, phrase or an
 *     overlap with a confidential fact — clientFacts.confidentialFilter);
 *   · THEIR words: visible to the client, or spoken by the client;
 *   · a decision, commitment, piece of feedback, reported result or brand
 *     preference — never an internal note, a production preference or an
 *     unreviewed proposal;
 *   · permanent, or scoped to this month;
 *   · about this topic: it shares its content words.
 * Never more than three, and shown as a suggestion with where it came from.
 */
const PROFILE_CATEGORIES = ["DECISION", "COMMITMENT", "FEEDBACK", "PERFORMANCE_REPORTED", "BRAND_PREFERENCE"];
const contentWords = (s: string | null | undefined) => new Set((s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4));

async function profileSuggestionsFor(row: { clientId: string; monthId: string; topicId: string }): Promise<SuggestedAnswer[]> {
  const topic = await prisma.contentTopic.findUnique({ where: { id: row.topicId }, select: { title: true, concept: true } });
  if (!topic) return [];
  const topicWords = contentWords(`${topic.title} ${topic.concept ?? ""}`);
  if (!topicWords.size) return [];
  const facts = await prisma.clientFact.findMany({
    where: {
      clientId: row.clientId, status: "ACCEPTED", aiContext: "ALLOWED", confidential: false, category: { in: PROFILE_CATEGORIES },
      OR: [{ scope: "PERMANENT" }, { scope: "MONTH", monthId: row.monthId }],
      AND: [{ OR: [{ visibility: "CLIENT" }, { speaker: "client" }] }],
    },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { id: true, body: true, factDate: true, updatedAt: true },
  });
  if (!facts.length) return [];
  const { confidentialFilter } = await import("@/lib/clientFacts");
  const secret = await confidentialFilter(row.clientId);
  const need = topicWords.size <= 3 ? 1 : 2;
  const out: SuggestedAnswer[] = [];
  for (const f of facts) {
    const text = f.body.replace(/\s+/g, " ").trim();
    // A bracketed marker ("[§25 acceptance fixture]", "[internal]") is a staff
    // note's, never a client's sentence.
    if (/\[[^\]]+\]/.test(text) || text.split(" ").length < 5 || secret(text)) continue;
    const shared = [...contentWords(text)].filter((w) => topicWords.has(w)).length;
    if (shared < need) continue;
    out.push({ id: sha256(`fact:${f.id}\n${text}`).slice(0, 24), text, kind: "profile", provenance: { callRecordId: null, callDateISO: (f.factDate ?? f.updatedAt).toISOString(), time: null, source: "your profile notes", factId: f.id } });
    if (out.length >= 3) break;
  }
  return out;
}

export async function suggestedAnswersFor(interviewId: string): Promise<SuggestedAnswer[]> {
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { topicId: true, monthId: true, clientId: true } });
  if (!row) return [];
  const { kept } = await safeTopicExcerpts(row.topicId, row.monthId, row.clientId);
  const seen = new Set<string>();
  const out: SuggestedAnswer[] = [];
  for (const e of kept) {
    if (e.speaker !== "client") continue;
    const text = e.text.trim();
    if (text.split(/\s+/).length < 5 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const time = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/.exec(e.source)?.[1] ?? null;
    out.push({ id: sha256(`${e.callRecordId ?? "call"}\n${text}`).slice(0, 24), text, kind: "call", provenance: { callRecordId: e.callRecordId, callDateISO: e.callDateISO, time, source: e.source } });
  }
  const profile = await profileSuggestionsFor(row).catch(() => []);
  return [...out.slice(0, 6), ...profile.filter((p) => !seen.has(p.text.toLowerCase()))].slice(0, 8);
}

export async function interviewsForMonth(monthId: string) {
  return prisma.contentInterview.findMany({ where: { monthId }, orderBy: { createdAt: "asc" } });
}

/** True when answers changed after the latest draft built from this interview — the UI offers "new draft from the changed answers". */
export async function answersChangedSinceLastDraft(interviewId: string): Promise<boolean> {
  const [latestAnswer, latestVersion] = await Promise.all([
    prisma.contentInterviewAnswer.findFirst({ where: { interviewId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.contentScriptVersion.findFirst({ where: { interviewId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  if (!latestAnswer || !latestVersion) return false;
  return latestAnswer.createdAt > latestVersion.createdAt;
}

/** Everything the question planner needs about one interview, in one read. */
export async function interviewPlanningContext(interviewId: string): Promise<{ topic: Topic; audience: string | null; clientName: string | null; enrollmentId: string; clientId: string; monthId: string; policyVersionId: string | null; strategyVersionId: string | null; hasPlan: boolean }> {
  const { topic, audience, clientName, row } = await topicForInterview(interviewId);
  // A GENERATED plan is identified by its RUN, not by reading the sentences.
  // getOrCreateInterview stores the six raw templates in the same column, and
  // five of those six carry no {{placeholder}} at all — so "does any stored
  // sentence look like a real question" is true of every interview ever
  // created and said "tailored" on all of them. ContentInterview.aiRunId is
  // written by planInterviewQuestions and by nothing else.
  const hasPlan = !!row.aiRunId && !!storedPhrasing(row.questionPlanJson);
  return { topic, audience, clientName, enrollmentId: row.enrollmentId, clientId: row.clientId, monthId: row.monthId, policyVersionId: row.policyVersionId, strategyVersionId: row.strategyVersionId, hasPlan };
}
