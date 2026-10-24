import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson, activePolicyVersion, setRunOutputRef } from "@/lib/aiRuns";
import { approvedStrategy } from "@/lib/contentStrategy";
import { listPillars } from "@/lib/contentPillars";
import { INTERVIEW_QUESTION_PLAN, GENERATION_POLICY_VERSION, type Topic } from "@/lib/contentPolicy";
import { buildQuestionRequestPrompt } from "@/lib/contentPolicy/prompts";
import { currentAnswers, requestPlanJson, interviewState, planMeta } from "@/lib/contentInterview";
import { segmentTranscript, topicKeywords, keywordWindows } from "@/lib/scriptWriter/passages";

// ---------------------------------------------------------------------------
// SEND QUESTION REQUEST (Oct 23 2026). Jordan: "on the monthly content
// scripting, allow me to have a button that says 'Send Question Request', that
// removes the script, and sends the topic to the client to request questions
// based on the topic so we have enough information for the script. Then the
// client gets an email with a link and says we need them to answer a few
// questions on the topic so we can finish scripting. AI creates the questions
// based on the topic, the client, and what we know about them, and anything
// they talked about on the strategy call for that month, if applicable."
//
// WHAT ONE PRESS DOES, in this order:
//   1. Refuses, in words, a script the client already has (shared, approved by
//      the client, or ever released), a filmed one, imported history, a bulk
//      plan's bank, and a client who plans their own content. A script pushed
//      to a client is never touched or re-shared (Jordan's rule).
//   2. Writes three to five questions with AI (the topic, the client file and
//      creative identity, their earlier scripts, and this month's strategy call
//      when one was held: scrubbed of anything confidential or about another
//      client, used and never quoted). If that fails, NOTHING has changed.
//   3. Withdraws the draft, in one transaction, and deletes nothing. The script
//      row and every version stay; the row steps off the month and the topic
//      (monthId/topicId/interviewId kept on this request's ledger row), its
//      status reads WITHDRAWN and its live versions WITHDRAWN, so no queue,
//      count, sweep, writer or share can see it as the topic's script. The
//      topic stays the month's pick, its answer route switches to WRITTEN, and
//      its questions are the AI's, stored in the interview's own question plan
//      (contentInterview.requestPlanJson: only these are asked).
//   4. Emails the client once (programReminders.sendQuestionRequestEmail): the
//      branded program email, a one-tap link straight to that topic's
//      questions, recorded on the month's reminder ledger. The hourly reminder
//      pass follows up on the house cadence until they answer.
//
// THE LEDGER is a ContentScriptRelease row (action QUESTION_REQUEST) on the
// withdrawn script: who, when, the questions, and everything Undo needs to put
// back exactly (the script's pointers and status, each version's status, the
// topic's route and status, the interview as it was).
//
// When the client answers, nothing here runs: the topic is FROM_ANSWERS like
// any written topic, and the drafting sweep (or a person's "Draft what's
// ready") writes the new draft from the answers, on the new writer for the
// clients it is switched on for. The card then leaves the Scripts tab.
// ---------------------------------------------------------------------------

export const QUESTION_REQUEST_ACTION = "QUESTION_REQUEST";
/** ContentScriptVersion.status / ContentScript.status of a draft withdrawn by a question request. */
export const WITHDRAWN = "WITHDRAWN";

const SHARED_ACTIONS = ["SHARE", "APPROVE_AND_SHARE", "UPDATE_SHARED", "CLIENT_APPROVED", "CLIENT_CHANGES"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "CARRIED", "PROPOSED"];

type Actor = { email: string; appUserId?: string | null };

type PriorInterview = {
  status: string; sourceKind: string; questionPlanJson: string | null; aiRunId: string | null;
  submittedAt: string | null; submittedByClientUserId: string | null; sentWithGapsAt: string | null; sentWithGapsByClientUserId: string | null;
  sufficiencyJson: string | null; sufficientAt: string | null; gapQuestionsAskedAt: string | null; currentQuestionKey: string | null; answeredCount: number;
};

export type QuestionRequestLedger = {
  v: 1;
  state: "OPEN" | "CANCELLED" | "ANSWERED";
  topicId: string;
  topicTitle: string;
  monthId: string;
  monthKey: string;
  interviewId: string;
  questions: { key: string; text: string }[];
  aiRunId: string | null;
  sentBy: string;
  prior: {
    script: { monthId: string | null; topicId: string | null; interviewId: string | null; status: string; releaseState: string | null; approvedVersionId: string | null; approvedAt: string | null; approvedBy: string | null };
    /** Each version's status before the withdrawal (only the ones it changed). */
    versions: Record<string, string>;
    currentVersionNo: number | null;
    answerRoute: string | null;
    topicStatus: string;
    /** null = the request opened the interview. */
    interview: PriorInterview | null;
  };
  cancelledAt?: string;
  cancelledBy?: string;
  answeredAt?: string;
};

export function readQuestionRequestLedger(note: string | null | undefined): QuestionRequestLedger | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as QuestionRequestLedger;
    return v && v.v === 1 && typeof v.topicId === "string" && typeof v.monthId === "string" ? v : null;
  } catch {
    return null;
  }
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const date = (s: string | null | undefined) => (s ? new Date(s) : null);
/** No em dashes in anything a client reads (Jordan's rule), and no stray whitespace. */
export const clientWords = (t: string) => t.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();

// ---- eligibility ------------------------------------------------------------

/** Why this script cannot be sent back for questions, in words; null = it can. */
export async function questionRequestRefusal(scriptId: string): Promise<string | null> {
  const s = await prisma.contentScript.findUnique({
    where: { id: scriptId },
    select: { id: true, title: true, enrollmentId: true, clientId: true, monthId: true, topicId: true, historical: true, status: true, currentVersionId: true, sharedVersionId: true, sharedAt: true, clientVisible: true, releaseState: true, clientApprovedVersionId: true, clientApprovedAt: true, clientChangesAt: true, videoId: true },
  });
  if (!s) return "That script no longer exists.";
  if (s.historical) return "Imported history: there is nothing to ask about.";
  if (s.status === WITHDRAWN) return "Already withdrawn: the questions went to the client. Undo or Resend them from the card.";
  if (!s.currentVersionId) return "That script has no version to withdraw.";
  const client = await prisma.client.findUnique({ where: { id: s.clientId }, select: { name: true } });
  const who = client?.name?.split(/\s+/)[0] || "the client";
  // NEVER A SCRIPT THE CLIENT ALREADY HAS (Jordan's rule, Oct 21 2026).
  // Audit, Oct 23 2026: every sign "Write it again" reads too (scriptRewrite.rewriteFactsFor): the
  // share stamps, a legacy client-visible row, and any version ever shared, not only the pointers.
  const [shares, sharedVersion] = await Promise.all([
    prisma.contentScriptRelease.count({ where: { scriptId: s.id, OR: [{ action: { in: SHARED_ACTIONS } }, { releasedAt: { not: null } }] } }),
    prisma.contentScriptVersion.findFirst({ where: { scriptId: s.id, OR: [{ sharedAt: { not: null } }, { status: "SHARED" }] }, select: { id: true } }),
  ]);
  if (s.clientApprovedVersionId || s.clientApprovedAt) return `${who} already approved this script, so it stays exactly as it is.`;
  if (s.sharedVersionId || s.sharedAt || s.clientVisible || ["CLIENT_VISIBLE", "READY_TO_FILM"].includes(s.status) || s.releaseState === "released" || s.clientChangesAt || shares > 0 || sharedVersion) return `This script was already sent to ${who}, so it stays as it is. Questions are only for a draft the client has not seen.`;
  const { readScriptsFilmed } = await import("@/lib/scriptFilmed");
  const filmed = s.videoId ? true : (await readScriptsFilmed([{ id: s.id, topicId: s.topicId, videoId: s.videoId }])).has(s.id);
  if (filmed) return "Its video is already filmed, so there is nothing left to ask.";
  if (!s.monthId || !s.topicId) return "This script is not on a month's plan, so there is no topic to ask about.";
  const [month, sel, enrollment] = await Promise.all([
    prisma.contentMonth.findUnique({ where: { id: s.monthId }, select: { status: true, historical: true } }),
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: s.topicId, monthId: s.monthId } }, select: { status: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: s.enrollmentId }, select: { status: true } }),
  ]);
  if (!month || month.historical || month.status !== "OPEN") return "That month is closed, so nothing is asked about it.";
  if (!sel || !LIVE_SELECTION.includes(sel.status)) return "That topic is no longer on the month's plan.";
  if (enrollment?.status !== "ACTIVE") return `${who}'s program is not active, so no email goes out.`;
  const { bulkMonthIds } = await import("@/lib/bulkPlan");
  if ((await bulkMonthIds()).has(s.monthId)) return "A bulk plan's script is the client's own bank: nothing is asked about it.";
  const { clientPlansOwnContent } = await import("@/lib/programStyle");
  if (await clientPlansOwnContent(s.enrollmentId)) return `${who} plans their own content: we write no scripts and ask no questions.`;
  // An AI revision still writing would land on the withdrawn draft.
  const running = await prisma.programAiRun.findFirst({ where: { status: { in: ["QUEUED", "RUNNING"] }, scopeJson: { contains: `"scriptId":"${s.id}"` }, NOT: { promptKey: "question-request" } }, select: { id: true } });
  if (running) return "An AI revision of this script is still running. Wait for it to finish, then send the questions.";
  return null;
}

// ---- the questions ------------------------------------------------------------

/** The house question, filled in for the topic (the fallback when the AI's own is unusable). */
function houseQuestion(id: string, topic: Topic, audience: string | null, clientName: string | null): string {
  const q = INTERVIEW_QUESTION_PLAN.find((x) => x.id === id)!;
  return clientWords(q.template.replace(/\{\{topic\}\}/g, topic.title).replace(/\{\{pillar\}\}/g, topic.pillarRef.pillarName).replace(/\{\{client\}\}/g, clientName ?? "you").replace(/\{\{audience\}\}/g, audience ?? "people in this situation"));
}

/**
 * This month's strategy call, the parts about this topic: the confirmed
 * transcript(s) of the month's calls (or the pasted one), cleaned by the same
 * scrub every generation prompt uses (confidential marks, confidential facts,
 * other clients' names), cut to the windows that talk about the topic when
 * it is long; plus the lines the call analysis recorded for the topic. Empty
 * when no call was held this month.
 */
async function monthCallText(o: { topicId: string; monthId: string; clientId: string; title: string; concept: string | null }): Promise<string> {
  const gen = await import("@/lib/contentGeneration");
  const month = await prisma.contentMonth.findUnique({ where: { id: o.monthId }, select: { callRecordId: true, transcriptText: true, notes: true } });
  const callIds = new Set<string>();
  if (month?.callRecordId) callIds.add(month.callRecordId);
  for (const c of await prisma.programCallRecord.findMany({ where: { monthId: o.monthId, clientId: o.clientId, status: { notIn: ["CANCELLED", "RESCHEDULED"] } }, select: { id: true }, take: 5 })) callIds.add(c.id);
  const sources = callIds.size
    ? await prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: [...callIds] }, matchState: "CONFIRMED", text: { not: null } }, orderBy: { version: "desc" }, select: { id: true, callRecordId: true, text: true, supersedesId: true } })
    : [];
  const superseded = new Set(sources.map((x) => x.supersedesId).filter(Boolean));
  const seen = new Set<string>();
  const raw: string[] = [];
  for (const t of sources) {
    if (superseded.has(t.id) || !t.callRecordId || seen.has(t.callRecordId)) continue;
    seen.add(t.callRecordId);
    raw.push(t.text!);
  }
  if (!raw.length && month?.transcriptText) raw.push(month.transcriptText);
  const quotable = await gen.quotableLinesForTopic(o.topicId, o.monthId, o.clientId).catch(() => [] as string[]);
  let keywords = topicKeywords(o.title, ...quotable);
  if (keywords.length < 4) keywords = topicKeywords(o.title, o.concept, ...quotable);
  const parts: string[] = [];
  let budget = 9000;
  for (const r of raw) {
    const clean = (await gen.scrubTranscriptForGeneration(o.clientId, r)).text;
    let text = clean;
    if (text.length > budget) {
      text = keywordWindows(segmentTranscript(clean), keywords, { radius: 6, max: 10, maxChars: Math.max(600, Math.floor(budget / 10)), minHits: 1 }).map((w) => `${w.time ? `(${w.time}) ` : ""}${w.text}`).join("\n...\n");
    }
    if (!text.trim()) continue;
    parts.push(text.slice(0, budget));
    budget -= Math.min(text.length, budget);
    if (budget < 1500) break;
  }
  // The call's notes, when the office kept any: the same scrub, short.
  if (month?.notes?.trim() && raw.length) {
    const notes = (await gen.scrubTranscriptForGeneration(o.clientId, month.notes)).text.trim();
    if (notes) parts.push(`Call notes: ${notes.slice(0, 1500)}`);
  }
  const { safeTopicExcerpts } = await import("@/lib/contentTopics");
  const { kept } = await safeTopicExcerpts(o.topicId, o.monthId, o.clientId).catch(() => ({ kept: [] as { speaker: string; text: string }[] }));
  if (kept.length) parts.push(`Lines the call analysis recorded for this topic:\n${kept.slice(0, 12).map((e) => `${e.speaker === "client" ? "Client" : e.speaker === "jordan" ? "Jordan" : "Someone else"}: ${e.text}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * Three to five questions for the topic, written by AI (kind interview_plan,
 * a person's press: no sweep switch applies, the caps do). Every one is a
 * house role, at most once; pointOfView and talkingPoints are always asked (a
 * script cannot exist without a stance and three points), with the house
 * wording filled in for the topic when the model's is missing or unusable.
 */
export async function writeRequestQuestions(o: { scriptId: string; versionId: string; topicId: string; monthId: string; enrollmentId: string; clientId: string; interviewId: string | null; requestedBy: string }): Promise<{ questions: { key: string; text: string }[]; runId: string; callChars: number }> {
  const gen = await import("@/lib/contentGeneration");
  const t = await prisma.contentTopic.findUnique({ where: { id: o.topicId } });
  if (!t) throw new Error("Topic not found.");
  const [built, strategy, pillars, client] = await Promise.all([
    gen.buildClientContext(o.enrollmentId, { monthId: o.monthId, excludeScriptId: o.scriptId }),
    approvedStrategy(o.enrollmentId),
    listPillars(o.enrollmentId, { includeRetired: true }),
    prisma.client.findUnique({ where: { id: o.clientId }, select: { name: true } }),
  ]);
  const pillarName = pillars.find((p) => p.id === t.pillarId)?.name ?? t.pillar ?? "";
  const topic: Topic = {
    id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage,
    source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: o.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: strategy?.label ?? null, stamp: null,
  };
  const callText = await monthCallText({ topicId: t.id, monthId: o.monthId, clientId: t.clientId, title: t.title, concept: t.concept });
  const prior = o.interviewId
    ? (await currentAnswers(o.interviewId)).filter((a) => a.answerKind !== "SKIPPED" && a.answerText?.trim()).slice(0, 12).map((a) => ({ question: a.questionText, answer: a.answerText!.trim().slice(0, 600) }))
    : [];
  const bundle = buildQuestionRequestPrompt(built.ctx, { topic, plan: INTERVIEW_QUESTION_PLAN, callText, priorAnswers: prior });
  type Out = { questions: { id: string; ask: string }[] };
  const run = await runAiJson<Out>({
    kind: "interview_plan", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { questionRequest: true, scriptId: o.scriptId, versionId: o.versionId, topicId: o.topicId, monthId: o.monthId },
    inputRefs: { ...built.inputRefs, topicTitle: t.title, callChars: callText.length, priorAnswers: prior.length }, promptKey: "question-request", promptVersion: `${GENERATION_POLICY_VERSION}/question-request.1`,
    policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: false,
    dedupeKey: `question-request:${o.scriptId}:${o.versionId}`, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 1500,
  });
  const allowed = new Set<string>(INTERVIEW_QUESTION_PLAN.map((q) => q.id));
  const usable = (s: unknown): s is string => typeof s === "string" && clientWords(s).length >= 12 && clientWords(s).length <= 300 && !s.includes("{{");
  const picked: { key: string; text: string }[] = [];
  for (const q of Array.isArray(run.output?.questions) ? run.output.questions : []) {
    if (!q || !allowed.has(q.id) || picked.some((p) => p.key === q.id) || !usable(q.ask)) continue;
    picked.push({ key: q.id, text: clientWords(q.ask) });
    if (picked.length >= 5) break;
  }
  const audience = strategy?.document?.targetAudience.primaryClientTypes ?? null;
  // The two a script cannot exist without, then enough to make three.
  for (const must of ["pointOfView", "talkingPoints"]) {
    if (picked.some((p) => p.key === must)) continue;
    const q = { key: must, text: houseQuestion(must, topic, audience, client?.name ?? null) };
    if (picked.length >= 5) picked.splice(picked.findIndex((p) => p.key !== "pointOfView" && p.key !== "talkingPoints" && p.key !== "audienceProblem") >= 0 ? picked.findIndex((p) => p.key !== "pointOfView" && p.key !== "talkingPoints" && p.key !== "audienceProblem") : picked.length - 1, 1, q);
    else picked.push(q);
  }
  for (const extra of ["audienceProblem", "nextAction", "evidence"]) {
    if (picked.length >= 3) break;
    if (!picked.some((p) => p.key === extra)) picked.push({ key: extra, text: houseQuestion(extra, topic, audience, client?.name ?? null) });
  }
  // The house order, so the client reads them the way the script is built.
  const order = INTERVIEW_QUESTION_PLAN.map((q) => q.id as string);
  picked.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { questions: picked, runId: run.runId, callChars: callText.length };
}

// ---- the press ----------------------------------------------------------------

export type SendQuestionRequestResult = {
  requestId: string;
  interviewId: string;
  questions: { key: string; text: string }[];
  email: { outcome: string; detail: string; at: Date | null };
  message: string;
};

export async function sendQuestionRequest(scriptId: string, actor: Actor, opts: { now?: Date } = {}): Promise<SendQuestionRequestResult> {
  const now = opts.now ?? new Date();
  const refusal = await questionRequestRefusal(scriptId);
  if (refusal) throw new Error(refusal);
  const s = (await prisma.contentScript.findUnique({ where: { id: scriptId } }))!;
  const monthId = s.monthId!;
  const topicId = s.topicId!;
  const [topic, month, sel, iv, versions, client] = await Promise.all([
    prisma.contentTopic.findUnique({ where: { id: topicId }, select: { id: true, title: true, status: true } }),
    prisma.contentMonth.findUnique({ where: { id: monthId }, select: { monthKey: true } }),
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId } }, select: { id: true, answerRoute: true } }),
    prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId, monthId } } }),
    prisma.contentScriptVersion.findMany({ where: { scriptId }, select: { id: true, status: true, versionNo: true } }),
    prisma.client.findUnique({ where: { id: s.clientId }, select: { name: true } }),
  ]);
  if (!topic || !month || !sel) throw new Error("That topic is no longer on the month's plan.");

  // 1 · The questions FIRST: if the model fails, nothing has changed.
  let q: Awaited<ReturnType<typeof writeRequestQuestions>>;
  try {
    q = await writeRequestQuestions({ scriptId, versionId: s.currentVersionId!, topicId, monthId, enrollmentId: s.enrollmentId, clientId: s.clientId, interviewId: iv?.id ?? null, requestedBy: actor.email });
  } catch (e) {
    throw new Error(`The questions couldn't be written (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200)}). Nothing changed: the draft is still here.`);
  }

  // 2 · The withdrawal, the route and the questions, in one transaction.
  const [policy, strategy] = await Promise.all([activePolicyVersion(), approvedStrategy(s.enrollmentId)]);
  // Stamped with the clock the answer rows are stamped with (the database's
  // write time), never a caller's `now`: an answer is "since the request" by it.
  const askedAt = new Date();
  const planJson = requestPlanJson(q.questions, askedAt);
  const changed = versions.filter((v) => ["DRAFT", "INTERNAL_REVIEW", "APPROVED"].includes(v.status));
  const ledger: QuestionRequestLedger = {
    v: 1, state: "OPEN", topicId, topicTitle: topic.title, monthId, monthKey: month.monthKey, interviewId: iv?.id ?? "", questions: q.questions, aiRunId: q.runId, sentBy: actor.email,
    prior: {
      script: { monthId: s.monthId, topicId: s.topicId, interviewId: s.interviewId, status: s.status, releaseState: s.releaseState, approvedVersionId: s.approvedVersionId, approvedAt: iso(s.approvedAt), approvedBy: s.approvedBy },
      versions: Object.fromEntries(changed.map((v) => [v.id, v.status])),
      currentVersionNo: versions.find((v) => v.id === s.currentVersionId)?.versionNo ?? null,
      answerRoute: sel.answerRoute,
      topicStatus: topic.status,
      interview: iv
        ? {
            status: iv.status, sourceKind: iv.sourceKind, questionPlanJson: iv.questionPlanJson, aiRunId: iv.aiRunId, submittedAt: iso(iv.submittedAt), submittedByClientUserId: iv.submittedByClientUserId,
            sentWithGapsAt: iso(iv.sentWithGapsAt), sentWithGapsByClientUserId: iv.sentWithGapsByClientUserId, sufficiencyJson: iv.sufficiencyJson, sufficientAt: iso(iv.sufficientAt),
            gapQuestionsAskedAt: iso(iv.gapQuestionsAskedAt), currentQuestionKey: iv.currentQuestionKey, answeredCount: iv.answeredCount,
          }
        : null,
    },
  };
  const { requestId, interviewId } = await prisma.$transaction(async (tx) => {
    const moved = await tx.contentScript.updateMany({
      where: { id: scriptId, historical: false, status: s.status, currentVersionId: s.currentVersionId, sharedVersionId: null, sharedAt: null, clientApprovedVersionId: null, clientApprovedAt: null, videoId: null },
      data: { monthId: null, topicId: null, interviewId: null, status: WITHDRAWN, releaseState: "withheld", approvedVersionId: null, approvedAt: null, approvedBy: null },
    });
    if (moved.count !== 1) throw new Error("The script changed while the questions were being written. Look at it again, then press Send Question Request if you still want to.");
    if (changed.length) await tx.contentScriptVersion.updateMany({ where: { id: { in: changed.map((v) => v.id) } }, data: { status: WITHDRAWN } });
    await tx.contentTopicSelection.update({ where: { id: sel.id }, data: { answerRoute: "WRITTEN" } });
    if (topic.status === "SCRIPTED") await tx.contentTopic.update({ where: { id: topicId }, data: { status: "SELECTED" } });
    let interviewId: string;
    if (iv) {
      await tx.contentInterview.update({
        where: { id: iv.id },
        data: {
          sourceKind: "WRITTEN", questionPlanJson: planJson, aiRunId: q.runId, status: "NOT_STARTED", submittedAt: null, submittedByClientUserId: null, sentWithGapsAt: null, sentWithGapsByClientUserId: null,
          sufficiencyJson: null, sufficientAt: null, gapQuestionsAskedAt: null, currentQuestionKey: null, lastActivityAt: askedAt,
        },
      });
      interviewId = iv.id;
    } else {
      const row = await tx.contentInterview.create({
        data: {
          topicId, monthId, enrollmentId: s.enrollmentId, clientId: s.clientId, strategyVersionId: strategy?.versionId ?? null, policyVersionId: policy.id,
          sourceKind: "WRITTEN", status: "NOT_STARTED", questionPlanJson: planJson, aiRunId: q.runId, staffUserId: actor.appUserId ?? actor.email, lastActivityAt: askedAt,
        },
        select: { id: true },
      });
      interviewId = row.id;
    }
    const rel = await tx.contentScriptRelease.create({
      data: {
        scriptId, scriptVersionId: s.currentVersionId!, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId, action: QUESTION_REQUEST_ACTION,
        actorAppUserId: actor.appUserId ?? null, actorEmail: actor.email, note: JSON.stringify({ ...ledger, interviewId }),
      },
      select: { id: true },
    });
    return { requestId: rel.id, interviewId };
  });

  // 3 · Bookkeeping, best effort: none of it can undo the withdrawal.
  await interviewState(interviewId).catch(() => null); // the status the answers so far give
  await setRunOutputRef(q.runId, `ContentScriptRelease:${requestId}`).catch(() => {});
  await import("@/lib/programDeskTasks").then((m) => m.closeAnswerGapTask(interviewId)).catch(() => {});
  const { recordTopicEvent } = await import("@/lib/contentTopics");
  await recordTopicEvent(topicId, s.enrollmentId, "EDITED", { kind: "STAFF", staffUserId: actor.appUserId ?? actor.email }, {
    monthId, fromStatus: topic.status, toStatus: topic.status === "SCRIPTED" ? "SELECTED" : topic.status, sourceRef: `ContentScriptRelease:${requestId}`,
    note: `Question request: the draft${ledger.prior.currentVersionNo ? ` (v${ledger.prior.currentVersionNo})` : ""} was withdrawn and kept in its history; ${q.questions.length} questions went to the client in writing`,
  }).catch(() => {});
  await import("@/lib/programMonths").then((m) => m.recalcProgramMonth(monthId)).catch(() => null);

  // 4 · The email, once (the ledger row's dedupeKey), on the month's reminder ledger.
  const { sendQuestionRequestEmail } = await import("@/lib/programReminders");
  const mail = await sendQuestionRequestEmail(requestId, { kind: "first", by: actor, now }).catch((e) => ({ reminderId: null, outcome: "failed" as const, detail: e instanceof Error ? e.message : String(e), nextEligibleAt: null as Date | null }));
  const first = client?.name?.split(/\s+/)[0] || "the client";
  const emailLine = mail.outcome === "sent"
    ? `${first} has the email now.`
    : mail.nextEligibleAt
      ? `The email goes out ${fmtWhen(mail.nextEligibleAt)} (client emails wait for office hours).`
      : `The email did not go out: ${mail.detail}. Resend it from the card when that's fixed.`;
  return {
    requestId, interviewId, questions: q.questions,
    email: { outcome: mail.outcome, detail: mail.detail, at: mail.outcome === "sent" ? now : mail.nextEligibleAt ?? null },
    message: `Withdrew the draft (kept in its history) and asked ${first} ${q.questions.length} questions about "${clientWords(topic.title)}". ${emailLine}`,
  };
}

const fmtWhen = (d: Date) => `${d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET`;

// ---- where a request stands -----------------------------------------------------

/**
 * Is the request still waiting on the client? It stops being open when it was
 * cancelled, when the client sent their answers after it was made (sufficient
 * or not: the house follow-up for thin answers is Kyle's, not this email's),
 * or when the topic got a new draft (from the answers, or any other way).
 */
export async function questionRequestStatus(rel: { id: string; createdAt: Date; note: string | null }): Promise<{ open: boolean; answered: boolean; drafted: boolean; ledger: QuestionRequestLedger | null; why: string }> {
  const ledger = readQuestionRequestLedger(rel.note);
  if (!ledger) return { open: false, answered: false, drafted: false, ledger, why: "the request's ledger cannot be read" };
  if (ledger.state === "CANCELLED") return { open: false, answered: false, drafted: false, ledger, why: "the request was undone" };
  const [iv, script, sel] = await Promise.all([
    ledger.interviewId ? prisma.contentInterview.findUnique({ where: { id: ledger.interviewId }, select: { status: true, submittedAt: true, sentWithGapsAt: true } }) : Promise.resolve(null),
    prisma.contentScript.findFirst({ where: { topicId: ledger.topicId, monthId: ledger.monthId, historical: false }, select: { id: true } }),
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: ledger.topicId, monthId: ledger.monthId } }, select: { status: true } }),
  ]);
  const sentAt = iv?.submittedAt ?? iv?.sentWithGapsAt ?? null;
  const answered = !!iv && (iv.status === "SUBMITTED" || iv.status === "SUBMITTED_WITH_GAPS") && !!sentAt && sentAt >= rel.createdAt;
  const drafted = !!script;
  if (drafted) return { open: false, answered, drafted, ledger, why: "the topic has a new draft" };
  if (answered) return { open: false, answered, drafted, ledger, why: "the client sent their answers" };
  if (ledger.state === "ANSWERED") return { open: false, answered: true, drafted, ledger, why: "the client answered" };
  if (!sel || !LIVE_SELECTION.includes(sel.status)) return { open: false, answered, drafted, ledger, why: "the topic left the month's plan" };
  return { open: true, answered, drafted, ledger, why: "waiting on the client's answers" };
}

/** Write a closed request's state on its ledger row (once), and stop its pending emails. */
export async function settleQuestionRequest(requestId: string, state: "ANSWERED" | "CANCELLED", extra: Partial<QuestionRequestLedger> = {}): Promise<void> {
  const rel = await prisma.contentScriptRelease.findUnique({ where: { id: requestId }, select: { id: true, note: true, enrollmentId: true } });
  const ledger = readQuestionRequestLedger(rel?.note);
  if (!rel || !ledger || ledger.state !== "OPEN") return;
  const next: QuestionRequestLedger = { ...ledger, ...extra, state, ...(state === "ANSWERED" ? { answeredAt: new Date().toISOString() } : {}) };
  await prisma.contentScriptRelease.updateMany({ where: { id: rel.id, note: rel.note }, data: { note: JSON.stringify(next) } });
  await prisma.programReminder.updateMany({
    where: { dedupeKey: { startsWith: questionRequestKeyPrefix(rel.enrollmentId, ledger.monthKey, rel.id) }, state: { in: ["PENDING", "FAILED"] } },
    data: { state: "CANCELLED", suppressionReason: state === "ANSWERED" ? "answered" : "request_cancelled", nextAttemptAt: null, leaseUntil: null, leaseBy: null },
  });
}

/**
 * The topics of a month whose question request is still OPEN (audit, Oct 23
 * 2026): the month's own answers ask (programReminders, COMPLETE_ANSWERS)
 * leaves them to the request's lane, so the client is chased once per topic.
 */
export async function openQuestionRequestTopicIds(monthId: string): Promise<Set<string>> {
  const rows = await prisma.contentScriptRelease.findMany({ where: { monthId, action: QUESTION_REQUEST_ACTION }, select: { note: true } });
  const out = new Set<string>();
  for (const r of rows) {
    const l = readQuestionRequestLedger(r.note);
    if (l && l.state === "OPEN" && l.monthId === monthId) out.add(l.topicId);
  }
  return out;
}

/** One request's rows on the reminder ledger share this dedupeKey prefix (attempt number last). */
export const questionRequestKeyPrefix = (enrollmentId: string, monthKey: string, requestId: string) => `${enrollmentId}:${monthKey}:${QUESTION_REQUEST_ACTION}:${requestId}:`;

// ---- Undo -------------------------------------------------------------------------

/**
 * UNDO (Jordan's ask, the same as every press in the hub): the withdrawn draft
 * is the topic's script again exactly as it was (pointers, status, every
 * version's status), the topic's route and status go back, the interview goes
 * back to how it was (or goes, when the request opened it and nothing was
 * answered; answers are never deleted), and no further email is sent. Refused
 * once a new draft exists for the topic: two scripts for one video is the
 * thing the hub never allows.
 */
export async function undoQuestionRequest(requestId: string, actor: Actor): Promise<{ message: string; monthId: string; enrollmentId: string }> {
  const rel = await prisma.contentScriptRelease.findUnique({ where: { id: requestId } });
  const ledger = readQuestionRequestLedger(rel?.note);
  if (!rel || rel.action !== QUESTION_REQUEST_ACTION || !ledger) throw new Error("That question request isn't on file.");
  if (ledger.state === "CANCELLED") throw new Error("Already undone.");
  const fresh = await prisma.contentScript.findFirst({ where: { topicId: ledger.topicId, monthId: ledger.monthId, historical: false }, select: { id: true } });
  if (fresh) throw new Error("Too late to undo: a new draft for this topic is already on the month. The withdrawn one stays in its history.");
  const p = ledger.prior;
  const iv = ledger.interviewId ? await prisma.contentInterview.findUnique({ where: { id: ledger.interviewId }, select: { id: true } }) : null;
  const answersSince = iv ? await prisma.contentInterviewAnswer.count({ where: { interviewId: iv.id, createdAt: { gte: rel.createdAt } } }) : 0;
  const answersEver = iv ? await prisma.contentInterviewAnswer.count({ where: { interviewId: iv.id } }) : 0;
  const scriptsOnInterview = iv ? await prisma.contentScriptVersion.count({ where: { interviewId: iv.id } }) : 0;
  await prisma.$transaction(async (tx) => {
    const back = await tx.contentScript.updateMany({
      where: { id: rel.scriptId, status: WITHDRAWN },
      data: { monthId: p.script.monthId, topicId: p.script.topicId, interviewId: p.script.interviewId, status: p.script.status, releaseState: p.script.releaseState, approvedVersionId: p.script.approvedVersionId, approvedAt: date(p.script.approvedAt), approvedBy: p.script.approvedBy },
    });
    if (back.count !== 1) throw new Error("The withdrawn draft is not where the request left it, so nothing was changed.");
    for (const [id, status] of Object.entries(p.versions)) await tx.contentScriptVersion.updateMany({ where: { id, scriptId: rel.scriptId, status: WITHDRAWN }, data: { status } });
    await tx.contentTopicSelection.updateMany({ where: { topicId: ledger.topicId, monthId: ledger.monthId }, data: { answerRoute: p.answerRoute } });
    if (p.topicStatus === "SCRIPTED") await tx.contentTopic.updateMany({ where: { id: ledger.topicId, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    if (iv) {
      if (!p.interview) {
        // The request opened it: gone when nothing was ever written in it, else set aside with the answers kept.
        if (!answersEver && !scriptsOnInterview) await tx.contentInterview.delete({ where: { id: iv.id } });
        else await tx.contentInterview.update({ where: { id: iv.id }, data: { status: "ABANDONED", lastActivityAt: new Date() } });
      } else {
        const pi = p.interview;
        await tx.contentInterview.update({
          where: { id: iv.id },
          data: {
            sourceKind: pi.sourceKind, questionPlanJson: pi.questionPlanJson, aiRunId: pi.aiRunId,
            // Answers written since the request stay; the interview then says so (its status is re-read below).
            ...(answersSince === 0
              ? {
                  status: pi.status, submittedAt: date(pi.submittedAt), submittedByClientUserId: pi.submittedByClientUserId, sentWithGapsAt: date(pi.sentWithGapsAt), sentWithGapsByClientUserId: pi.sentWithGapsByClientUserId,
                  sufficiencyJson: pi.sufficiencyJson, sufficientAt: date(pi.sufficientAt), gapQuestionsAskedAt: date(pi.gapQuestionsAskedAt), currentQuestionKey: pi.currentQuestionKey, answeredCount: pi.answeredCount,
                }
              : {}),
          },
        });
      }
    }
    await tx.contentScriptRelease.update({ where: { id: rel.id }, data: { note: JSON.stringify({ ...ledger, state: "CANCELLED", cancelledAt: new Date().toISOString(), cancelledBy: actor.email }) } });
  });
  // No further email: anything still waiting on the ledger is cancelled.
  await prisma.programReminder.updateMany({
    where: { dedupeKey: { startsWith: questionRequestKeyPrefix(rel.enrollmentId, ledger.monthKey, rel.id) }, state: { in: ["PENDING", "FAILED"] } },
    data: { state: "CANCELLED", suppressionReason: "request_cancelled", nextAttemptAt: null, leaseUntil: null, leaseBy: null },
  });
  if (iv && p.interview && answersSince > 0) await interviewState(iv.id).catch(() => null);
  const { recordTopicEvent } = await import("@/lib/contentTopics");
  await recordTopicEvent(ledger.topicId, rel.enrollmentId, "EDITED", { kind: "STAFF", staffUserId: actor.appUserId ?? actor.email }, {
    monthId: ledger.monthId, sourceRef: `ContentScriptRelease:${rel.id}`, note: `Question request undone: the draft${p.currentVersionNo ? ` (v${p.currentVersionNo})` : ""} is the topic's script again${answersSince ? "; what the client wrote since is kept" : ""}`,
  }).catch(() => {});
  await import("@/lib/programMonths").then((m) => m.recalcProgramMonth(ledger.monthId)).catch(() => null);
  return { message: `Undone: the draft${p.currentVersionNo ? ` (v${p.currentVersionNo})` : ""} is back, and no more emails go out about it.${answersSince ? " What the client wrote since is kept." : ""}`, monthId: ledger.monthId, enrollmentId: rel.enrollmentId };
}

// ---- Resend ---------------------------------------------------------------------------

/** A new email with a new one-tap link, while the request is still open. */
export async function resendQuestionRequest(requestId: string, actor: Actor, opts: { now?: Date } = {}): Promise<{ message: string; enrollmentId: string; outcome: string }> {
  const rel = await prisma.contentScriptRelease.findUnique({ where: { id: requestId }, select: { id: true, action: true, note: true, createdAt: true, enrollmentId: true, clientId: true } });
  if (!rel || rel.action !== QUESTION_REQUEST_ACTION) throw new Error("That question request isn't on file.");
  const st = await questionRequestStatus(rel);
  if (!st.open) throw new Error(st.drafted ? "Nothing to resend: the topic has a new draft." : st.answered ? "Nothing to resend: they already sent their answers." : `Nothing to resend: ${st.why}.`);
  const { sendQuestionRequestEmail } = await import("@/lib/programReminders");
  const mail = await sendQuestionRequestEmail(requestId, { kind: "resend", by: actor, now: opts.now });
  const client = await prisma.client.findUnique({ where: { id: rel.clientId }, select: { name: true } });
  const first = client?.name?.split(/\s+/)[0] || "the client";
  return {
    enrollmentId: rel.enrollmentId, outcome: mail.outcome,
    message: mail.outcome === "sent" ? `Sent ${first} a new link to the questions.` : mail.nextEligibleAt ? `A new link goes to ${first} ${fmtWhen(mail.nextEligibleAt)} (client emails wait for office hours).` : `Not sent: ${mail.detail}.`,
  };
}

// ---- the office card -------------------------------------------------------------------

export type QuestionRequestUi = {
  id: string;
  scriptId: string;
  topicTitle: string;
  clientFirstName: string;
  createdAt: string;
  sentBy: string;
  questions: string[];
  /** Questions answered so far (in writing, since the request). */
  answered: number;
  /** WAITING: nothing sent back yet. ANSWERED: their answers are in and the new draft is on its way. */
  stage: "WAITING" | "ANSWERED";
  email: { state: "sent" | "queued" | "failed" | "not_sent" | "none"; at: string | null; note: string | null; count: number };
  withdrawn: { versionNo: number | null; body: string | null };
};

/** The month's open question requests, for the Scripts tab (a drafted or undone one is not shown). */
export async function questionRequestsForMonth(monthId: string): Promise<QuestionRequestUi[]> {
  const rows = await prisma.contentScriptRelease.findMany({ where: { monthId, action: QUESTION_REQUEST_ACTION }, orderBy: { createdAt: "desc" }, take: 40 });
  const out: QuestionRequestUi[] = [];
  for (const rel of rows) {
    const st = await questionRequestStatus(rel);
    const ledger = st.ledger;
    if (!ledger || ledger.state === "CANCELLED" || st.drafted) continue;
    if (!st.open && !st.answered) continue;
    const [client, emails, version, answers] = await Promise.all([
      prisma.client.findUnique({ where: { id: rel.clientId }, select: { name: true } }),
      prisma.programReminder.findMany({ where: { dedupeKey: { startsWith: questionRequestKeyPrefix(rel.enrollmentId, ledger.monthKey, rel.id) } }, orderBy: { attempt: "desc" }, select: { state: true, sentAt: true, nextEligibleAt: true, suppressionReason: true, lastError: true, createdAt: true } }),
      prisma.contentScriptVersion.findUnique({ where: { id: rel.scriptVersionId }, select: { versionNo: true, body: true } }),
      ledger.interviewId ? prisma.contentInterviewAnswer.findMany({ where: { interviewId: ledger.interviewId, createdAt: { gte: rel.createdAt }, answerKind: { not: "SKIPPED" } }, select: { questionKey: true } }) : Promise.resolve([]),
    ]);
    const sent = emails.filter((r) => r.state === "SENT");
    const latest = emails[0] ?? null;
    const email: QuestionRequestUi["email"] = sent.length
      ? { state: "sent", at: iso(sent[0].sentAt), note: null, count: sent.length }
      : !latest
        ? { state: "none", at: null, note: null, count: 0 }
        : latest.state === "PENDING" || latest.state === "QUEUED"
          ? { state: "queued", at: iso(latest.nextEligibleAt), note: null, count: 0 }
          : latest.state === "FAILED"
            ? { state: "failed", at: null, note: latest.lastError, count: 0 }
            : { state: "not_sent", at: null, note: latest.suppressionReason ?? latest.lastError, count: 0 };
    const asked = new Set(ledger.questions.map((q) => q.key));
    out.push({
      id: rel.id, scriptId: rel.scriptId, topicTitle: ledger.topicTitle, clientFirstName: client?.name?.split(/\s+/)[0] || "the client", createdAt: rel.createdAt.toISOString(), sentBy: ledger.sentBy,
      questions: ledger.questions.map((q) => q.text), answered: new Set(answers.map((a) => a.questionKey.split(":fu:")[0]).filter((k) => asked.has(k))).size,
      stage: st.answered ? "ANSWERED" : "WAITING", email, withdrawn: { versionNo: version?.versionNo ?? null, body: version?.body ?? null },
    });
  }
  return out;
}

/** The asked subset of an interview, for a reader that only has the row. */
export function askedQuestionCount(questionPlanJson: string | null | undefined): number {
  return planMeta(questionPlanJson).asked?.length ?? INTERVIEW_QUESTION_PLAN.length;
}
