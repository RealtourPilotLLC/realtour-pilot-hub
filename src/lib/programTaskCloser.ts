import "server-only";
import { prisma } from "@/lib/prisma";
import { TASK_DONE_INCLUDING_LEGACY, ANSWER_GAP_TASK_PREFIX } from "@/lib/programDeskTasks";

// ---------------------------------------------------------------------------
// STALE PROGRAM TASKS CLOSE THEMSELVES (Oct 22 2026, audit M2).
//
// Three kinds of desk task are raised by the Content Program and, until now,
// were only ever closed by a forfeit, a catch-up or a late session:
//   · the reminder ESCALATION ("<client>: 2026-10 still needs <action>"),
//     programReminders.escalate;
//   · the ANSWER-GAP follow-up ("Follow up on their answers"),
//     programDeskTasks.openAnswerGapTask;
//   · the DISCOVERY BOOKING ("Book the brand discovery call"),
//     programOnboarding.onProgramActivated;
//   · (Oct 25 2026, audit) the 15th's MID-MONTH CHECK for Kyle ("<client>:
//     mid-month check on 2026-10"), programReminders.raiseMidMonthFollowUp.
//     Janice Pigga booked her October session on Oct 23 and hers stayed open
//     beside the ones that still mattered (Mike Ciunci, Kristen Pavillard).
// Erica booked her October session and her "still needs a content session
// booking" stayed open; three "still needs a planning path" tasks stayed open
// after each month's route was chosen; Marcee's answer-gap task stayed open
// after her script was approved; Joe Sutow's discovery task has been open since
// Sep 22 although his strategy is approved and his onboarding is complete.
//
// Hourly (cron sync, the programMonths step, desk truth outside every switch)
// each open one is checked against the condition that raised it. When the
// condition no longer holds the task is COMPLETED with a plain note saying why;
// a task whose condition still holds is left exactly as it is. Nothing here
// contacts anyone, and a task a person already closed is never touched.
// ---------------------------------------------------------------------------

export const ESCALATION_TASK_PREFIX = "program-reminder-escalation:";
export const DISCOVERY_TASK_PREFIX = "program-discovery-booking:";
export const MIDMONTH_TASK_PREFIX = "program-reminder-midmonth:";

export type TaskKind = "escalation" | "answer_gap" | "discovery" | "midmonth";
export type TaskVerdict = {
  taskId: string;
  dedupeKey: string;
  kind: TaskKind;
  title: string;
  /** true = the condition that raised it still holds; the task stays open. */
  holds: boolean;
  /** What was read, in plain words: the note a closed task carries. */
  evidence: string;
};

const TASK_PREFIXES = [ESCALATION_TASK_PREFIX, ANSWER_GAP_TASK_PREFIX, DISCOVERY_TASK_PREFIX, MIDMONTH_TASK_PREFIX];
const kindOf = (key: string): TaskKind | null =>
  key.startsWith(ESCALATION_TASK_PREFIX) ? "escalation"
    : key.startsWith(ANSWER_GAP_TASK_PREFIX) ? "answer_gap"
    : key.startsWith(DISCOVERY_TASK_PREFIX) ? "discovery"
    : key.startsWith(MIDMONTH_TASK_PREFIX) ? "midmonth"
    : null;

const day = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "an unknown date");
const LIVE_INTERVIEW = ["SUBMITTED_WITH_GAPS", "IN_PROGRESS", "NEEDS_FOLLOWUP", "NOT_STARTED"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"];
/** The onboarding steps at or past a held discovery call (programOnboarding's ladder). */
const PAST_DISCOVERY = ["DISCOVERY_HELD", "TRANSCRIPT_PENDING", "STRATEGY_DRAFTED", "STRATEGY_IN_REVIEW", "STRATEGY_APPROVED", "BANK_GENERATED", "COMPLETE", "WAIVED"];

/** An escalation: `program-reminder-escalation:<monthId>:<ACTION>[:<review batch>]`. */
export function parseEscalationKey(key: string): { monthId: string; action: string } | null {
  if (!key.startsWith(ESCALATION_TASK_PREFIX)) return null;
  const [monthId, action] = key.slice(ESCALATION_TASK_PREFIX.length).split(":");
  return monthId && action ? { monthId, action } : null;
}

async function escalationVerdict(key: string, now: Date, cache: Map<string, { holds: boolean; evidence: string }>): Promise<{ holds: boolean; evidence: string }> {
  const parsed = parseEscalationKey(key);
  if (!parsed) return { holds: true, evidence: "the task's key could not be read, so it is left for a person" };
  const cacheKey = `${parsed.monthId}:${parsed.action}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const { reminderAskStillOpen } = await import("@/lib/programReminders");
  const v = await reminderAskStillOpen(parsed.monthId, parsed.action, { now });
  cache.set(cacheKey, v);
  return v;
}

/**
 * The 15th's follow-up (`program-reminder-midmonth:<monthId>`) asked Kyle to
 * help with whatever the month still needed. It holds while the month's
 * planning lane still asks the client for something (a snoozed or held ask
 * still counts); once it asks nothing, the help is no longer needed.
 */
async function midMonthVerdict(key: string, now: Date, cache: Map<string, { holds: boolean; evidence: string }>): Promise<{ holds: boolean; evidence: string }> {
  const monthId = key.slice(MIDMONTH_TASK_PREFIX.length).split(":")[0];
  if (!monthId) return { holds: true, evidence: "the task's key could not be read, so it is left for a person" };
  const hit = cache.get(`mid:${monthId}`);
  if (hit) return hit;
  const { monthPrimaryAsk } = await import("@/lib/programReminders");
  const ask = await monthPrimaryAsk(monthId, { now });
  const v = { holds: ask.action !== null, evidence: ask.evidence };
  cache.set(`mid:${monthId}`, v);
  return v;
}

async function answerGapVerdict(key: string): Promise<{ holds: boolean; evidence: string }> {
  const interviewId = key.slice(ANSWER_GAP_TASK_PREFIX.length);
  const iv = interviewId ? await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { status: true, topicId: true, monthId: true, enrollmentId: true } }) : null;
  if (!iv) return { holds: false, evidence: "the topic's answers are no longer on file" };
  if (!LIVE_INTERVIEW.includes(iv.status)) return { holds: false, evidence: `the answers are now ${iv.status.toLowerCase().replace(/_/g, " ")}` };
  const [enrollment, month, selection, script] = await Promise.all([
    prisma.contentEnrollment.findUnique({ where: { id: iv.enrollmentId }, select: { status: true } }),
    prisma.contentMonth.findUnique({ where: { id: iv.monthId }, select: { monthKey: true, status: true } }),
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: iv.topicId, monthId: iv.monthId } }, select: { status: true } }),
    prisma.contentScript.findFirst({ where: { topicId: iv.topicId, monthId: iv.monthId, historical: false }, orderBy: { updatedAt: "desc" }, select: { approvedAt: true, approvedVersionId: true, createdAt: true } }),
  ]);
  if (enrollment && enrollment.status !== "ACTIVE") return { holds: false, evidence: `the program is ${enrollment.status.toLowerCase()}` };
  if (month && month.status !== "OPEN") return { holds: false, evidence: `${month.monthKey} is ${month.status.toLowerCase()}` };
  if (!selection || !LIVE_SELECTION.includes(selection.status)) return { holds: false, evidence: "the topic is no longer on the month" };
  if (script?.approvedVersionId) return { holds: false, evidence: `the topic's script was approved on ${day(script.approvedAt)}, so the answers no longer hold anything up` };
  if (script) return { holds: false, evidence: `the topic's script was drafted on ${day(script.createdAt)}, so the answers no longer hold anything up` };
  return { holds: true, evidence: `the answers are ${iv.status.toLowerCase().replace(/_/g, " ")} and no script exists for the topic yet` };
}

async function discoveryVerdict(key: string): Promise<{ holds: boolean; evidence: string }> {
  const enrollmentId = key.slice(DISCOVERY_TASK_PREFIX.length);
  const e = enrollmentId ? await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, status: true } }) : null;
  if (!e) return { holds: false, evidence: "the program is no longer on file" };
  if (e.status !== "ACTIVE") return { holds: false, evidence: `the program is ${e.status.toLowerCase()}` };
  const [booking, onboarding, strategy] = await Promise.all([
    prisma.programCallRecord.findFirst({ where: { callType: "BRAND_DISCOVERY", status: { notIn: ["CANCELLED"] }, OR: [{ enrollmentId }, { clientId: e.clientId }] }, orderBy: { scheduledStart: "desc" }, select: { scheduledStart: true, status: true } }),
    prisma.programOnboarding.findFirst({ where: { enrollmentId }, select: { status: true } }),
    prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: "APPROVED" }, orderBy: { versionNo: "desc" }, select: { versionNo: true, approvedAt: true } }),
  ]);
  if (booking) return { holds: false, evidence: `a brand discovery call is on file (${booking.status.toLowerCase()}, ${day(booking.scheduledStart)})` };
  if (strategy) return { holds: false, evidence: `the content strategy (v${strategy.versionNo}) was approved on ${day(strategy.approvedAt)} and onboarding is ${(onboarding?.status ?? "unknown").toLowerCase().replace(/_/g, " ")}, so discovery is done although no Calendly discovery booking was recorded` };
  if (onboarding && PAST_DISCOVERY.includes(onboarding.status)) return { holds: false, evidence: `onboarding is past discovery (${onboarding.status.toLowerCase().replace(/_/g, " ")})` };
  return { holds: true, evidence: "no brand discovery call is on file and no strategy is approved yet" };
}

/**
 * Every open escalation, answer-gap, discovery and mid-month task, with whether its
 * condition still holds and the evidence. Reads only (the escalation check is
 * the reminder preview's evaluation, which writes nothing). `taskIds` narrows
 * it; `budgetMs` stops before the clock runs out (the rest wait an hour).
 */
export async function programTaskVerdicts(opts: { now?: Date; budgetMs?: number; taskIds?: string[]; max?: number } = {}): Promise<{ verdicts: TaskVerdict[]; outOfTime: boolean }> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const open = await prisma.smartTask.findMany({
    where: { status: { notIn: TASK_DONE_INCLUDING_LEGACY }, OR: TASK_PREFIXES.map((p) => ({ dedupeKey: { startsWith: p } })), ...(opts.taskIds ? { id: { in: opts.taskIds } } : {}) },
    orderBy: { createdAt: "asc" },
    take: opts.max ?? 60,
    select: { id: true, dedupeKey: true, title: true },
  });
  const cache = new Map<string, { holds: boolean; evidence: string }>();
  const verdicts: TaskVerdict[] = [];
  let outOfTime = false;
  for (const t of open) {
    if (opts.budgetMs != null && Date.now() - started > opts.budgetMs) { outOfTime = true; break; }
    const key = t.dedupeKey ?? "";
    const kind = kindOf(key);
    if (!kind) continue;
    let v: { holds: boolean; evidence: string };
    try {
      v = kind === "escalation" ? await escalationVerdict(key, now, cache)
        : kind === "answer_gap" ? await answerGapVerdict(key)
        : kind === "midmonth" ? await midMonthVerdict(key, now, cache)
        : await discoveryVerdict(key);
    } catch (e) {
      // Unreadable is never a reason to close: the task stays for a person.
      v = { holds: true, evidence: `could not be checked: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
    }
    verdicts.push({ taskId: t.id, dedupeKey: key, kind, title: t.title, ...v });
  }
  return { verdicts, outOfTime };
}

/** The note a closed task carries (plain words, no em dashes). */
export function closingNote(evidence: string, now: Date): string {
  return `Closed by the hub on ${day(now)}: ${evidence.replace(/\s*—\s*/g, ", ")}.`;
}

/**
 * THE HOURLY PASS. Closes each open task whose condition no longer holds, with
 * the note appended to its description; a task a person closed in the meantime
 * is left as they left it (the write is fenced on the task still being open).
 * `dryRun` reports the same verdicts and writes nothing.
 */
export async function closeResolvedProgramTasks(opts: { now?: Date; budgetMs?: number; taskIds?: string[]; dryRun?: boolean } = {}): Promise<{ checked: number; closed: number; kept: number; outOfTime: boolean; verdicts: TaskVerdict[] }> {
  const now = opts.now ?? new Date();
  const { verdicts, outOfTime } = await programTaskVerdicts({ now, budgetMs: opts.budgetMs, taskIds: opts.taskIds });
  let closed = 0;
  for (const v of verdicts) {
    if (v.holds || opts.dryRun) continue;
    const t = await prisma.smartTask.findUnique({ where: { id: v.taskId }, select: { description: true } });
    const note = closingNote(v.evidence, now);
    const r = await prisma.smartTask.updateMany({
      where: { id: v.taskId, status: { notIn: TASK_DONE_INCLUDING_LEGACY } },
      data: { status: "COMPLETED", completedAt: now, description: `${t?.description ? `${t.description}\n\n` : ""}${note}`.slice(0, 20_000) },
    });
    closed += r.count;
  }
  return { checked: verdicts.length, closed, kept: verdicts.filter((v) => v.holds).length, outOfTime, verdicts };
}
