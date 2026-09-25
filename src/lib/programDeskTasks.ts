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
  /** Default: two days from now. */
  dueAt?: Date | null;
  priority?: "URGENT" | "HIGH" | "MEDIUM";
};

/**
 * Raise (or refresh) one desk task for the program, identified by its own
 * dedupeKey. Never for a TEST client. The caller owns the key, because the
 * tasks this raises answer different questions and must not share one.
 */
export async function openProgramDeskTask(input: ProgramDeskTaskInput): Promise<void> {
  // A probe may ask for TEST work to be raised (the address lane's rule).
  if (isTestClientName(input.clientName) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1") return;
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
        taskType: "todo", status: "OPEN", source: "content_program", priority: input.priority ?? "HIGH",
        clientId: input.clientId, dedupeKey: input.dedupeKey, assignedKey: input.assignedKey,
        dueAt: input.dueAt ?? new Date(Date.now() + 2 * 864e5),
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

// ---------------------------------------------------------------------------
// WHO A PROGRAM DUTY BELONGS TO, as a SmartTask assignee (first name,
// lowercased — the hub's convention; programReminders.escalationOwner reads it
// the same way). Falls back to the given key when nobody is assigned.
// ---------------------------------------------------------------------------
export async function dutyAssignedKey(enrollmentId: string, monthId: string | null, duty: "SCRIPTS" | "SCHEDULING" | "ESCALATION", fallback: string): Promise<string> {
  try {
    const { ownersFor } = await import("@/lib/contentProgram");
    const owners = await ownersFor(enrollmentId, monthId);
    const o = owners[duty] ?? owners.ESCALATION;
    const first = (o?.label ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    // ensureDefaultOwnerAssignments labels an empty seat "unassigned" — not a person.
    return first && first !== "unassigned" ? first : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// A DRAFT THAT KEEPS FAILING HAS AN OWNER (6.5, Sep 25 2026).
//
// A failed unattended draft was visible only as the automation row's lastError
// and a topic still on the "owed" list — nobody's job. Two failures in a row
// for the same topic and month (the model runs the ledger records, newest
// first, since the last success) put one task on the scripts owner with the
// error and where "Draft what's ready" is. The next successful draft closes it.
// ---------------------------------------------------------------------------

export const DRAFT_FAILED_TASK_PREFIX = "program-draft-failed:";
export const draftFailedKey = (topicId: string, monthId: string) => `${DRAFT_FAILED_TASK_PREFIX}${topicId}:${monthId}`;

/** How many of this topic's most recent draft runs for this month failed in a row. */
export async function consecutiveDraftFailures(topicId: string, monthId: string): Promise<{ count: number; lastError: string | null }> {
  const runs = await prisma.programAiRun.findMany({
    where: { kind: "script_draft", scopeJson: { contains: `"topicId":"${topicId}"` } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { status: true, scopeJson: true, error: true },
  });
  let count = 0;
  let lastError: string | null = null;
  for (const r of runs) {
    let scope: { monthId?: string | null } = {};
    try { scope = JSON.parse(r.scopeJson ?? "{}"); } catch { continue; }
    if (scope.monthId !== monthId) continue;
    if (r.status === "RUNNING" || r.status === "QUEUED") continue;
    if (r.status !== "FAILED") break;
    count++;
    lastError ??= r.error;
  }
  return { count, lastError };
}

/** After a draft attempt: close the task on success, open it on the second failure in a row. */
export async function noteDraftOutcome(w: { topicId: string; monthId: string; monthKey: string; enrollmentId: string; clientId: string; clientName: string | null; title: string }, result: "drafted" | "failed", error?: string | null): Promise<"opened" | "closed" | "none"> {
  const key = draftFailedKey(w.topicId, w.monthId);
  if (result === "drafted") return (await closeProgramDeskTask(key)) ? "closed" : "none";
  const { count, lastError } = await consecutiveDraftFailures(w.topicId, w.monthId);
  if (count < 2) return "none";
  const had = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } }).catch(() => null);
  await openProgramDeskTask({
    dedupeKey: key, clientId: w.clientId, clientName: w.clientName ?? "",
    title: `Script draft keeps failing — ${w.clientName ?? "program client"} · “${w.title}”`,
    lines: [
      `The automatic draft for this topic (${w.monthKey}) has failed ${count} times in a row, so the client's script is not being written.`,
      "",
      `Last error: ${(error ?? lastError ?? "unknown").slice(0, 400)}`,
      "",
      `Draft it now: Content Program → this client → Plan → Scripts → “Draft what's ready” (/content/${w.enrollmentId}?tab=plan&view=scripts), or write it by hand.`,
      "This closes itself the next time the draft succeeds.",
    ],
    assignedKey: await dutyAssignedKey(w.enrollmentId, w.monthId, "SCRIPTS", "jordan"),
    reasonCreated: "Script draft failed twice in a row (6.5)",
    reopenIfClosed: true,
  });
  return had ? "none" : "opened";
}

// ---------------------------------------------------------------------------
// SCRIPTS NOT APPROVED BEFORE FILMING (6.5, Jordan's answer Sep 25 2026).
//
// Internal and always on (desk truth, like the address task): the client's
// email is programReminders' SCRIPTS lane, behind `reminders`. Here:
//   · at `scriptApproval.deskTaskLeadHours` (24) before a session, shared
//     scripts still without the client's approval — or planned scripts not
//     yet shared — put ONE follow-up on Kyle (the scheduling owner), per
//     session; it closes when they are approved or the session starts;
//   · within `ownerBellLeadHours` (72) of a session, scripts still in the
//     team's queue ring the scripts owner's bell, once per session.
// Never a cancellation, never a move: the session stands (Jordan).
// ---------------------------------------------------------------------------

export const SCRIPTS_UNAPPROVED_TASK_PREFIX = "program-scripts-unapproved:";
/** `<prefix><monthId>:<sessionKey>` — the month travels in the key, so closing needs nothing else. */
export const scriptsUnapprovedKey = (monthId: string, sessionKey: string) => `${SCRIPTS_UNAPPROVED_TASK_PREFIX}${monthId}:${sessionKey}`;

const whenET = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

export async function reconcileScriptApprovalTasks(opts: { now?: Date; max?: number; /** Read only: report what would open, close and ring; write nothing. */ dryRun?: boolean } = {}): Promise<{ opened: number; closed: number; bells: number; checkedSessions: number; wouldOpen: string[]; wouldRing: string[] }> {
  const now = opts.now ?? new Date();
  const { reminderPolicy, monthScriptApprovals } = await import("@/lib/programReminders");
  const { policy } = await reminderPolicy({ orDefaults: true });
  const wouldOpen: string[] = [];
  const wouldRing: string[] = [];
  if (!policy) return { opened: 0, closed: 0, bells: 0, checkedSessions: 0, wouldOpen, wouldRing };
  const lead = policy.scriptApproval;
  let opened = 0, closed = 0, bells = 0, checkedSessions = 0;
  const { upcomingProgramSessions } = await import("@/lib/sessionAddress");

  // 1. CLOSE what is no longer true: the session started, or nothing is pending.
  const open = await prisma.smartTask.findMany({ where: { dedupeKey: { startsWith: SCRIPTS_UNAPPROVED_TASK_PREFIX }, status: { notIn: TASK_DONE_INCLUDING_LEGACY } }, select: { dedupeKey: true }, take: opts.max ?? 100 });
  for (const t of open) {
    const rest = (t.dedupeKey ?? "").slice(SCRIPTS_UNAPPROVED_TASK_PREFIX.length);
    const cut = rest.indexOf(":");
    const monthId = cut > 0 ? rest.slice(0, cut) : null;
    const sessionKey = cut > 0 ? rest.slice(cut + 1) : rest;
    const session = monthId ? (await upcomingProgramSessions(monthId, now)).find((x) => x.key === sessionKey) ?? null : null;
    const pending = monthId ? await monthScriptApprovals(monthId) : null;
    const stillOwed = !!pending && pending.awaitingClient.length + pending.changesRequested.length + pending.notShared.length > 0;
    if (!session || !stillOwed) { if (opts.dryRun) closed++; else if (await closeProgramDeskTask(t.dedupeKey!)) closed++; }
  }

  // 2. OPEN / RING for sessions inside their windows.
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true, clientId: true } });
  if (!live.length) return { opened, closed, bells, checkedSessions, wouldOpen, wouldRing };
  const curKey = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: { in: live.map((e) => e.id) }, historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] }, monthKey: { gte: curKey } }, select: { id: true, monthKey: true, enrollmentId: true, clientId: true }, take: opts.max ?? 100 });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(months.map((m) => m.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name ?? ""]));
  const horizon = Math.max(lead.deskTaskLeadHours, lead.ownerBellLeadHours) * 3_600_000;
  for (const m of months) {
    const sessions = (await upcomingProgramSessions(m.id, now)).filter((x) => x.startsAt.getTime() - now.getTime() <= horizon);
    if (!sessions.length) continue;
    const pending = await monthScriptApprovals(m.id);
    const name = names.get(m.clientId) ?? "";
    for (const x of sessions) {
      checkedSessions++;
      const hoursLeft = (x.startsAt.getTime() - now.getTime()) / 3_600_000;
      const waiting = [...pending.awaitingClient, ...pending.changesRequested];
      if (hoursLeft <= lead.deskTaskLeadHours && waiting.length + pending.notShared.length > 0) {
        const key = scriptsUnapprovedKey(m.id, x.key);
        const had = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } }).catch(() => null);
        if (opts.dryRun) {
          if (!had && (!isTestClientName(name) || process.env.PROGRAM_DESK_TASKS_FOR_TEST === "1")) wouldOpen.push(`${name} · ${whenET(x.startsAt)} · ${waiting.length} awaiting, ${pending.notShared.length} not shared`);
        } else {
          await openProgramDeskTask({
            dedupeKey: key, clientId: m.clientId, clientName: name,
            title: `Scripts not approved before filming — ${name || "program client"} · ${whenET(x.startsAt)}`,
            lines: [
              `Filming is ${whenET(x.startsAt)} ET. We film either way; nothing is cancelled or moved.`,
              ...(pending.awaitingClient.length ? ["", "Waiting on the client's approval:", ...pending.awaitingClient.map((a) => `• ${a.title}`)] : []),
              ...(pending.changesRequested.length ? ["", "The client asked for changes (with the scripts owner):", ...pending.changesRequested.map((a) => `• ${a.title}`)] : []),
              ...(pending.notShared.length ? ["", "Not shared with the client yet:", ...pending.notShared.map((a) => `• ${a.title} (${a.stage})`)] : []),
              "",
              "Give the client a quick call or text so the words on camera are the ones they chose. This closes itself once they are approved or the session starts.",
            ],
            assignedKey: await dutyAssignedKey(m.enrollmentId, m.id, "SCHEDULING", "kyle"),
            reasonCreated: "Scripts not approved 24 hours before filming (6.5)",
            reopenIfClosed: false,
            dueAt: x.startsAt,
            priority: "URGENT",
          });
          if (!had && (await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true } }).catch(() => null))) opened++;
        }
      }
      // The team's own queue, three days out: the scripts owner hears first.
      if (hoursLeft <= lead.ownerBellLeadHours && pending.notShared.length > 0 && (!isTestClientName(name) || process.env.PROGRAM_DESK_TASKS_FOR_TEST === "1")) {
        const bellKey = `scripts-before-shoot:${x.key}`;
        const already = await prisma.notification.count({ where: { dedupeKey: { startsWith: bellKey } } }).catch(() => 0);
        if (!already && opts.dryRun) wouldRing.push(`${name} · ${whenET(x.startsAt)} · ${pending.notShared.length} not shared`);
        else if (!already) {
          const { notifyInApp } = await import("@/lib/notify");
          await notifyInApp({
            kind: "scripts_before_shoot",
            title: `${pending.notShared.length} script${pending.notShared.length === 1 ? "" : "s"} not shared, filming ${whenET(x.startsAt)} — ${name}`.slice(0, 90),
            body: pending.notShared.map((a) => `${a.title} (${a.stage})`).join(" · "),
            href: `/content/${m.enrollmentId}?tab=plan&view=scripts`,
            targets: [{ roles: ["OWNER"] }],
            dedupeKey: bellKey,
          }).catch(() => null);
          bells++;
        }
      }
    }
  }
  return { opened, closed, bells, checkedSessions, wouldOpen, wouldRing };
}
