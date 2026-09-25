import "server-only";
import { prisma } from "@/lib/prisma";
import { isTestClientName } from "@/lib/testClients";
import { addBusinessDaysET } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// PROGRAM DESK TASKS — the one way the Content Program puts a job on Kyle's
// list (SmartTask), and takes it off again.
//
// Moved out of programOnboarding.ts (Sep 24 2026, CP-08) so the answer-gap
// follow-up and the discovery-scheduling task share one writer: identified by
// the caller's own dedupeKey, never for a TEST client, and an open row whose
// facts have moved is REWRITTEN rather than left stale (the reason for that
// rule is in the comment below, from the onboarding work it came from).
//
// A desk task is DESK TRUTH, not automation: it is reconciled whether or not
// any switch is on, the way reconcileDiscoveryTasks is — `reminders` decides
// whether a client is emailed, not whether Kyle's list tells the truth.
// ---------------------------------------------------------------------------

/** SmartTask.status values that mean "done" everywhere in the hub. */
export const TASK_DONE = ["COMPLETED", "CANCELLED"];
/** TASK_DONE plus the two statuses an early cut of the onboarding tasks wrote. Nothing carries them now; they are read so a legacy row is never re-opened by mistake. */
export const TASK_DONE_INCLUDING_LEGACY = [...TASK_DONE, "DONE", "CLOSED"];

export type ProgramDeskTaskInput = {
  dedupeKey: string;
  clientId: string;
  clientName: string;
  title: string;
  lines: string[];
  assignedKey: string;
  reasonCreated: string;
  reopenIfClosed: boolean;
};

/**
 * Raise (or refresh) one desk task for the program, identified by its own
 * dedupeKey. Never for a TEST client. The caller owns the key, because the
 * tasks this raises answer different questions and must not share one.
 */
export async function openProgramDeskTask(input: ProgramDeskTaskInput): Promise<void> {
  if (isTestClientName(input.clientName)) return;
  const description = input.lines.join("\n");
  const title = input.title.slice(0, 140);
  const existing = await prisma.smartTask
    .findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true, status: true, title: true, description: true } })
    .catch(() => null);
  if (existing) {
    if (TASK_DONE_INCLUDING_LEGACY.includes(existing.status)) {
      if (!input.reopenIfClosed) return;
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "OPEN", completedAt: null, title, description } }).catch(() => {});
      return;
    }
    // STILL OPEN, AND THE FACTS HAVE MOVED. The first cut returned here without
    // rewriting anything, so whichever version of a task was written first won
    // and every later one was dropped on the floor — which is how the identity
    // question stayed invisible in the payment-first order. Rewriting an open
    // machine-raised row is not overwriting a person's work: the description IS
    // the evidence, and stale evidence is worse than none.
    if (existing.title !== title || existing.description !== description) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { title, description } }).catch(() => {});
    }
    return;
  }
  await prisma.smartTask
    .create({
      data: {
        title, description, summary: input.title.slice(0, 200),
        taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH",
        clientId: input.clientId, dedupeKey: input.dedupeKey, assignedKey: input.assignedKey,
        dueAt: new Date(Date.now() + 2 * 864e5),
        reasonCreated: input.reasonCreated,
      },
    })
    .catch(() => {});
}

/** Close a machine-raised desk task that is no longer true. A task a person already closed is left as they closed it. */
export async function closeProgramDeskTask(dedupeKey: string): Promise<boolean> {
  const r = await prisma.smartTask.updateMany({ where: { dedupeKey, status: { notIn: TASK_DONE_INCLUDING_LEGACY } }, data: { status: "COMPLETED", completedAt: new Date() } });
  return r.count > 0;
}

// ---------------------------------------------------------------------------
// THE ANSWER-GAP FOLLOW-UP (CP-08).
//
// A client who sends answers that cannot carry a script (SUBMITTED_WITH_GAPS),
// or who has been sitting on the targeted gap questions for two business days,
// is Kyle's to follow up — Jordan: "provide the follow-up email/link". The task
// carries the questions still open (house or per-topic wording — never a fact
// from the file) and says where the follow-up link is. It closes itself the
// moment the interview is sufficient and sent.
// ---------------------------------------------------------------------------

export const ANSWER_GAP_TASK_PREFIX = "program-answer-gaps:";
const answerGapKey = (interviewId: string) => `${ANSWER_GAP_TASK_PREFIX}${interviewId}`;
/** How long an unanswered gap question waits before it becomes Kyle's. */
export const GAP_QUESTION_GRACE_BUSINESS_DAYS = 2;

export type AnswerGapFollowUp = {
  interviewId: string;
  topicTitle: string;
  monthKey: string;
  /** At most two, in the order the gap phase asks them. */
  questions: string[];
  /** Portal path suffix for the deep link: `?tab=topics&iv=<id>`. */
  path: string;
};

/** The questions still open on one interview, phrased the way the client would read them. */
export async function answerGapFollowUp(interviewId: string): Promise<AnswerGapFollowUp | null> {
  const iv = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, topicId: true, monthId: true } });
  if (!iv) return null;
  const [{ interviewState }, { INTERVIEW_QUESTION_PLAN }] = await Promise.all([import("@/lib/contentInterview"), import("@/lib/contentPolicy")]);
  const [st, topic, month] = await Promise.all([
    // Read-only: composing a follow-up (or previewing a reminder) must not
    // move the interview's status or start its gap clock.
    interviewState(interviewId, { readOnly: true }),
    prisma.contentTopic.findUnique({ where: { id: iv.topicId }, select: { title: true } }),
    prisma.contentMonth.findUnique({ where: { id: iv.monthId }, select: { monthKey: true } }),
  ]);
  if (st.sufficiency.ready) return null;
  const questions: string[] = [];
  // The next step when it is a question; otherwise the house gap wording for
  // each missing piece, filled for the topic.
  if (st.next.kind !== "done") questions.push(st.next.prompt);
  const fieldQ: Record<string, { q: string; cond: string }> = { premise: { q: "audienceProblem", cond: "gap-premise" }, stance: { q: "pointOfView", cond: "gap-stance" }, points: { q: "talkingPoints", cond: "gap-points" } };
  for (const f of st.sufficiency.missing) {
    if (questions.length >= 2) break;
    const map = fieldQ[f];
    const q = INTERVIEW_QUESTION_PLAN.find((x) => x.id === map.q);
    const ask = q?.followUps.find((x) => x.when === map.cond)?.ask;
    if (!ask) continue;
    const text = ask.replace(/\{\{topic\}\}/g, topic?.title ?? "this topic");
    if (!questions.includes(text)) questions.push(text);
  }
  return { interviewId, topicTitle: topic?.title ?? "a topic", monthKey: month?.monthKey ?? "", questions: questions.slice(0, 2), path: `?tab=topics&iv=${interviewId}` };
}

/** Raise (or refresh) Kyle's follow-up for one interview. */
export async function openAnswerGapTask(interviewId: string, why: "SENT_WITH_GAPS" | "STALLED"): Promise<void> {
  const iv = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, clientId: true } });
  if (!iv) return;
  const [client, gap] = await Promise.all([
    prisma.client.findUnique({ where: { id: iv.clientId }, select: { name: true } }),
    answerGapFollowUp(interviewId),
  ]);
  if (!gap) return;
  const name = client?.name ?? "program client";
  await openProgramDeskTask({
    dedupeKey: answerGapKey(interviewId),
    clientId: iv.clientId,
    clientName: client?.name ?? "",
    title: `Follow up on their answers — ${name} · “${gap.topicTitle}”`,
    lines: [
      why === "SENT_WITH_GAPS"
        ? "They sent their answers for this topic with gaps — not enough to write the script yet. Nothing is drafted until this is filled."
        : `They have had the follow-up question${gap.questions.length === 1 ? "" : "s"} for more than ${GAP_QUESTION_GRACE_BUSINESS_DAYS} business days without answering.`,
      "",
      `Still open${gap.monthKey ? ` (${gap.monthKey})` : ""}:`,
      ...gap.questions.map((q) => `• ${q}`),
      "",
      "Send them the follow-up link — Content Program → Video Topics → “Copy follow-up link” on this topic opens these questions directly.",
      "This closes itself once their answers are sufficient and sent.",
    ],
    assignedKey: "kyle",
    reasonCreated: why === "SENT_WITH_GAPS" ? "Planning answers sent with gaps" : "Gap questions unanswered for two business days",
    reopenIfClosed: false,
  });
}

export async function closeAnswerGapTask(interviewId: string): Promise<boolean> {
  return closeProgramDeskTask(answerGapKey(interviewId));
}

/**
 * ANSWERS SENT BEFORE CP-08 THAT CANNOT CARRY A SCRIPT (review, Sep 24 2026).
 * The old submit only asked "are the questions done?", so an interview that
 * finished short was stored SUBMITTED with its own reading {"sufficient":false}
 * beside it. The new rules read that row as thin — no draft, and on a written-
 * planning month no session booking — but nothing followed it up: the gap task
 * only looked at SUBMITTED_WITH_GAPS. Such a row IS what SUBMITTED_WITH_GAPS
 * now means, so it is called that (sent when it was sent, with no submittedAt,
 * exactly as a gap send writes it), and the follow-up below picks it up in the
 * same pass. A row with a script for its month already is left alone: it was
 * drafted, and "nothing is drafted until this is filled" would not be true.
 */
export async function reclassifyLegacyThinSubmissions(opts: { max?: number } = {}): Promise<number> {
  const rows = await prisma.contentInterview.findMany({
    where: { status: "SUBMITTED", sufficiencyJson: { contains: '"sufficient":false' } },
    select: { id: true, topicId: true, monthId: true, submittedAt: true, sufficiencyJson: true, submittedByClientUserId: true },
    take: opts.max ?? 50,
  });
  let n = 0;
  for (const iv of rows) {
    let stored: unknown = null;
    try { stored = (JSON.parse(iv.sufficiencyJson ?? "") as { sufficient?: unknown }).sufficient; } catch { stored = null; }
    if (stored !== false) continue;
    const drafted = await prisma.contentScript.count({ where: { topicId: iv.topicId, monthId: iv.monthId, historical: false } });
    if (drafted) continue;
    const r = await prisma.contentInterview.updateMany({
      where: { id: iv.id, status: "SUBMITTED" },
      data: { status: "SUBMITTED_WITH_GAPS", sentWithGapsAt: iv.submittedAt ?? new Date(), sentWithGapsByClientUserId: iv.submittedByClientUserId, submittedAt: null },
    });
    n += r.count;
  }
  return n;
}

/**
 * HOURLY, outside every switch (desk truth). Opens the follow-up for sent-with-
 * gaps interviews and for gap questions left unanswered past the grace period,
 * and closes it for interviews that are now sufficient, sent, or gone.
 */
export async function reconcileAnswerGapTasks(opts: { max?: number; now?: Date } = {}): Promise<{ opened: number; closed: number; reclassified: number }> {
  const now = opts.now ?? new Date();
  const max = opts.max ?? 50;
  let opened = 0, closed = 0;
  const reclassified = await reclassifyLegacyThinSubmissions({ max });
  const open = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: ANSWER_GAP_TASK_PREFIX }, status: { notIn: TASK_DONE_INCLUDING_LEGACY } }, select: { dedupeKey: true }, take: max });
  for (const t of open) {
    const id = (t.dedupeKey ?? "").slice(ANSWER_GAP_TASK_PREFIX.length);
    const iv = id ? await prisma.contentInterview.findUnique({ where: { id }, select: { status: true } }) : null;
    if (!iv || iv.status === "SUBMITTED" || iv.status === "SUFFICIENT" || iv.status === "ABANDONED") {
      if (await closeProgramDeskTask(t.dedupeKey!)) closed++;
    }
  }
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!live.length) return { opened, closed, reclassified };
  // "Stalled" is either state a gap question leaves behind: still waiting on
  // it (IN_PROGRESS — the gap question is the next step) or past both of them
  // and still short (NEEDS_FOLLOWUP).
  const candidates = await prisma.contentInterview.findMany({
    where: { enrollmentId: { in: live.map((e) => e.id) }, OR: [{ status: "SUBMITTED_WITH_GAPS" }, { status: { in: ["IN_PROGRESS", "NEEDS_FOLLOWUP"] }, gapQuestionsAskedAt: { not: null } }] },
    select: { id: true, status: true, gapQuestionsAskedAt: true },
    take: max,
  });
  for (const iv of candidates) {
    const stalled = iv.status !== "SUBMITTED_WITH_GAPS" && !!iv.gapQuestionsAskedAt && addBusinessDaysET(iv.gapQuestionsAskedAt, GAP_QUESTION_GRACE_BUSINESS_DAYS) <= now;
    if (iv.status !== "SUBMITTED_WITH_GAPS" && !stalled) continue;
    const had = await prisma.smartTask.findUnique({ where: { dedupeKey: answerGapKey(iv.id) }, select: { id: true } }).catch(() => null);
    await openAnswerGapTask(iv.id, iv.status === "SUBMITTED_WITH_GAPS" ? "SENT_WITH_GAPS" : "STALLED");
    if (!had && (await prisma.smartTask.findUnique({ where: { dedupeKey: answerGapKey(iv.id) }, select: { id: true } }).catch(() => null))) opened++;
  }
  return { opened, closed, reclassified };
}

/**
 * The client-facing paragraph a planning reminder adds for the first gap
 * interview of a month, plus its deep link. The questions are the house or
 * per-topic wording — never a fact from the file. No em dashes, and it ends
 * with the way forward (Jordan's rule for anything a client reads).
 */
export async function monthAnswerGapParagraph(monthId: string): Promise<{ paragraph: string; path: string } | null> {
  const iv = await prisma.contentInterview.findFirst({ where: { monthId, OR: [{ status: "SUBMITTED_WITH_GAPS" }, { status: "NEEDS_FOLLOWUP" }, { status: "IN_PROGRESS", gapQuestionsAskedAt: { not: null } }] }, orderBy: { updatedAt: "desc" }, select: { id: true } });
  if (!iv) return null;
  const gap = await answerGapFollowUp(iv.id);
  if (!gap || !gap.questions.length) return null;
  const strip = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");
  const paragraph = [
    `We're nearly there on "${strip(gap.topicTitle)}". ${gap.questions.length === 1 ? "One quick question" : "Two quick questions"} and we can write it:`,
    ...gap.questions.map((q) => `- ${strip(q)}`),
    "The link below opens them directly.",
  ].join("\n");
  return { paragraph, path: gap.path };
}
