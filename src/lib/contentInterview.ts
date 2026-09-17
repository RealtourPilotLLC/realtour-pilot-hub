import "server-only";
import { prisma } from "@/lib/prisma";
import { activePolicyVersion } from "@/lib/aiRuns";
import { approvedStrategy } from "@/lib/contentStrategy";
import { listPillars } from "@/lib/contentPillars";
import {
  INTERVIEW_QUESTION_PLAN, nextQuestion, assembleScriptInputs,
  type InterviewAnswer, type InterviewQuestionId, type NextStep, type ScriptGeneratorInput, type Topic, type FollowUpCondition,
} from "@/lib/contentPolicy";

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

const ROLE_OF: Record<InterviewQuestionId, string> = {
  audienceProblem: "AUDIENCE_PROBLEM", pointOfView: "POINT_OF_VIEW", talkingPoints: "TALKING_POINT", evidence: "EVIDENCE", story: "STORY", nextAction: "NEXT_STEP",
};
const QUESTION_IDS = new Set<string>(INTERVIEW_QUESTION_PLAN.map((q) => q.id));
const followUpKey = (qid: InterviewQuestionId, cond: FollowUpCondition) => `${qid}:fu:${cond}`;

export async function getOrCreateInterview(topicId: string, monthId: string, actor: { staffUserId?: string | null; clientUserId?: string | null }): Promise<string> {
  const existing = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId, monthId } }, select: { id: true } });
  if (existing) return existing.id;
  const [t, m] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: topicId }, select: { enrollmentId: true, clientId: true } }),
    prisma.contentMonth.findUnique({ where: { id: monthId }, select: { enrollmentId: true } }),
  ]);
  if (!t || !m) throw new Error("Topic or month not found.");
  if (t.enrollmentId !== m.enrollmentId) throw new Error("That month belongs to another client.");
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(t.enrollmentId)]);
  try {
    const row = await prisma.contentInterview.create({
      data: {
        topicId, monthId, enrollmentId: t.enrollmentId, clientId: t.clientId, strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id,
        sourceKind: "WRITTEN", status: "NOT_STARTED", questionPlanJson: JSON.stringify(INTERVIEW_QUESTION_PLAN.map((q) => ({ key: q.id, role: ROLE_OF[q.id], text: q.template }))),
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

/** The live (non-superseded) answer rows, newest version per question key. */
export async function currentAnswers(interviewId: string) {
  const rows = await prisma.contentInterviewAnswer.findMany({ where: { interviewId }, orderBy: [{ questionKey: "asc" }, { version: "desc" }] });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.questionKey) ? false : (seen.add(r.questionKey), true)));
}

async function topicForInterview(interviewId: string): Promise<{ topic: Topic; audience: string | null; clientName: string | null; row: NonNullable<Awaited<ReturnType<typeof prisma.contentInterview.findUnique>>> }> {
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId } });
  if (!row) throw new Error("Interview not found.");
  const [t, client, strategy, pillars] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: row.topicId } }),
    prisma.client.findUnique({ where: { id: row.clientId }, select: { name: true } }),
    approvedStrategy(row.enrollmentId),
    listPillars(row.enrollmentId, { includeRetired: true }),
  ]);
  if (!t) throw new Error("Topic not found.");
  const pillarName = pillars.find((p) => p.id === t.pillarId)?.name ?? t.pillar ?? "(no pillar)";
  const topic: Topic = {
    id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage,
    source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: row.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: strategy?.label ?? null, stamp: null,
  };
  return { topic, audience: strategy?.document?.targetAudience.primaryClientTypes ?? null, clientName: client?.name ?? null, row };
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
  interviewId: string; status: string; answeredCount: number; next: NextStep; sufficiency: { ready: boolean; substantiveAnswered: number; substantiveTotal: number; gaps: { kind: string; field: string | null; text: string; question: string | null }[] };
  answers: { questionKey: string; questionText: string; answerText: string | null; answerKind: string; version: number; answeredAt: string }[];
  /** The stored key the next step writes to (question id, or "<id>:fu:<condition>"). */
  nextKey: string | null;
};

/** Where the interview stands: the next question (or done), completeness, and the answers so far. Pure over the rows; safe to call on every render. */
export async function interviewState(interviewId: string): Promise<InterviewState> {
  const { topic, audience, clientName, row } = await topicForInterview(interviewId);
  const rows = await currentAnswers(interviewId);
  const answers = toPolicyAnswers(rows);
  const next = nextQuestion(answers, { topic, audience, clientName });
  const inputs = assembleScriptInputs(answers, topic, row.strategyVersionId);
  const nextKey = next.kind === "question" ? next.question.id : next.kind === "follow-up" ? followUpKey(next.question.id, next.condition) : null;
  const status = next.kind === "done" ? (inputs.completeness.ready ? "SUFFICIENT" : "NEEDS_FOLLOWUP") : rows.length ? "IN_PROGRESS" : "NOT_STARTED";
  if (row.status !== status && row.status !== "SUBMITTED" && row.status !== "ABANDONED") {
    await prisma.contentInterview.update({ where: { id: interviewId }, data: { status, currentQuestionKey: nextKey, answeredCount: rows.filter((r) => r.answerKind !== "SKIPPED").length, sufficiencyJson: JSON.stringify({ sufficient: inputs.completeness.ready, missing: inputs.gaps.map((g) => g.text) }), sufficientAt: inputs.completeness.ready ? new Date() : null } }).catch(() => {});
  }
  return {
    interviewId, status: row.status === "SUBMITTED" || row.status === "ABANDONED" ? row.status : status, answeredCount: rows.length, next, nextKey,
    sufficiency: { ready: inputs.completeness.ready, substantiveAnswered: inputs.completeness.substantiveAnswered, substantiveTotal: inputs.completeness.substantiveTotal, gaps: inputs.gaps },
    answers: rows.map((r) => ({ questionKey: r.questionKey, questionText: r.questionText, answerText: r.answerText, answerKind: r.answerKind, version: r.version, answeredAt: r.answeredAt.toISOString() })),
  };
}

/**
 * Answer (or skip / "don't know") one question. Always a NEW row: version n+1
 * with supersedesId → the previous row, so no edit can erase an answer and a
 * script that cited the old row still points at exactly what it read.
 */
export async function answerQuestion(interviewId: string, questionKey: string, input: { text?: string | null; kind: "TYPED" | "SKIPPED" | "DONT_KNOW"; actor: { staffUserId?: string | null; clientUserId?: string | null }; questionText?: string | null }): Promise<{ answerId: string; version: number }> {
  const row = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, status: true } });
  if (!row) throw new Error("Interview not found.");
  if (row.status === "SUBMITTED") {
    // Answers after submission are allowed (they produce a NEW draft), but the
    // interview steps back to IN_PROGRESS so the state is honest.
    await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "IN_PROGRESS", submittedAt: null } });
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
    const { topic, audience, clientName } = await topicForInterview(interviewId);
    const raw = isFollowUp ? q.followUps.find((f) => f.when === m[2])?.ask ?? q.template : q.template;
    questionText = raw.replace(/\{\{topic\}\}/g, topic.title).replace(/\{\{pillar\}\}/g, topic.pillarRef.pillarName).replace(/\{\{client\}\}/g, clientName ?? "you").replace(/\{\{audience\}\}/g, audience ?? "people in this situation");
  }
  const prev = await prisma.contentInterviewAnswer.findFirst({ where: { interviewId, questionKey }, orderBy: { version: "desc" }, select: { id: true, version: true } });
  const text = input.kind === "TYPED" ? (input.text ?? "").trim().slice(0, 8000) : null;
  if (input.kind === "TYPED" && !text) throw new Error("Type an answer, or skip the question.");
  const created = await prisma.contentInterviewAnswer.create({
    data: {
      interviewId, questionKey, questionRole: isFollowUp ? "FOLLOWUP" : ROLE_OF[q.id], questionText, answerText: text, answerKind: input.kind,
      sourceKind: input.actor.clientUserId ? "CLIENT" : "STAFF", clientUserId: input.actor.clientUserId ?? null, staffUserId: input.actor.staffUserId ?? null,
      version: (prev?.version ?? 0) + 1, supersedesId: prev?.id ?? null,
    },
    select: { id: true, version: true },
  });
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { lastActivityAt: new Date(), status: "IN_PROGRESS" } });
  await interviewState(interviewId); // recompute status/sufficiency
  return { answerId: created.id, version: created.version };
}

/** The generator input plus the ids of the exact answer rows it was built from. */
export async function assembleInterviewInputs(interviewId: string): Promise<{ input: ScriptGeneratorInput; answerIds: string[]; topic: Topic; enrollmentId: string; clientId: string; monthId: string; strategyVersionId: string | null; policyVersionId: string | null }> {
  const { topic, row } = await topicForInterview(interviewId);
  const rows = await currentAnswers(interviewId);
  const input = assembleScriptInputs(toPolicyAnswers(rows), topic, row.strategyVersionId);
  return { input, answerIds: rows.map((r) => r.id), topic, enrollmentId: row.enrollmentId, clientId: row.clientId, monthId: row.monthId, strategyVersionId: row.strategyVersionId, policyVersionId: row.policyVersionId };
}

export async function submitInterview(interviewId: string, actor: { staffUserId?: string | null; clientUserId?: string | null }): Promise<void> {
  const st = await interviewState(interviewId);
  if (st.next.kind !== "done") throw new Error("There is still a question to answer (or skip) before submitting.");
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { status: "SUBMITTED", submittedAt: new Date(), submittedByClientUserId: actor.clientUserId ?? null, staffUserId: actor.staffUserId ?? undefined } });
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
