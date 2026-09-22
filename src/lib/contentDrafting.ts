import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";

// ---------------------------------------------------------------------------
// THE DRAFTING CHAIN (spec §6/§7, F07 + F08) — Sep 22 2026.
//
// Two planning paths produce a month's scripts, and until today NEITHER of
// them reached a script on its own:
//
//   CALL PATH      a monthly strategy call is transcribed, ANALYZEd into
//                  PROPOSED selections, a person reconciles them — and then
//                  nothing happened. `SCRIPT_DRAFT` is a real job kind with a
//                  real handler, and `enqueueTranscriptJob(... "SCRIPT_DRAFT")`
//                  appears NOWHERE in the tree. The legacy
//                  ContentMonth.transcriptText sweep still calls
//                  generateScriptsForMonth, so the OLD path worked and the new
//                  one silently did not.
//
//   WRITTEN PATH   the client answers the per-topic questions in the portal and
//                  presses send. portalSubmitInterview tells them, in these
//                  words, "we'll draft the script from your answers and share
//                  it here for your read-through". submitInterview() set a
//                  status and stopped. The promise was made to a client and
//                  nothing kept it.
//
// This module is the missing link for both, and it is deliberately a SWEEP
// rather than a call inside the server action: a script draft is a 20-60s model
// call, a portal submit must return immediately, and a fire-and-forget promise
// in a serverless action is not durable. The client is told the truth ("we'll
// draft it"), the work is owed, and the sweep settles the debt.
//
// WHAT IT WILL NOT DO.
//   · It never drafts from nothing. A topic with no answers and no call
//     excerpts is THIN: real evidence is absent, so an unattended run leaves it
//     for a person and says why. A person may still ask for it explicitly.
//   · It never drafts a topic a person has not committed to. A PROPOSED
//     selection is the call's suggestion, not the month's plan.
//   · Nothing it produces is approved, released or client-visible. Every draft
//     lands in the same review lane a hand-written one does.
//
// THE SWITCH. `script_drafting` gates the unattended sweep, and `ai_runs` gates
// the model call underneath it — so turning the master switch off stops this
// even if somebody turns the specific one on. A missing row is OFF for both.
// ---------------------------------------------------------------------------

/** Why a topic in a planned month does or does not have a script yet. */
export type ScriptReadiness =
  /** Already drafted — nothing owed. */
  | "HAS_SCRIPT"
  /** The client's own answers are sufficient. The best evidence there is. */
  | "FROM_ANSWERS"
  /** Speaker-tagged excerpts from the planning call back this topic. */
  | "FROM_CALL"
  /** Committed, but the only inputs are the topic line and the strategy. */
  | "THIN"
  /** Questions opened and not finished — the client still owes us words. */
  | "WAITING_ON_ANSWERS"
  /** The call proposed it; no one has reconciled the month's plan yet. */
  | "WAITING_ON_PLANNING";

export type ScriptWorkItem = {
  topicId: string;
  title: string;
  monthId: string;
  monthKey: string;
  enrollmentId: string;
  clientId: string;
  clientName: string | null;
  readiness: ScriptReadiness;
  /** Plain English, for the workspace card and for the sweep's own log. */
  why: string;
  scriptId: string | null;
  interviewId: string | null;
  interviewStatus: string | null;
  callRecordId: string | null;
  excerpts: number;
};

const READY_TO_DRAFT: ReadonlySet<ScriptReadiness> = new Set<ScriptReadiness>(["FROM_ANSWERS", "FROM_CALL"]);
/** True for the states an unattended sweep may act on. THIN needs a person. */
export const isAutoDraftable = (r: ScriptReadiness): boolean => READY_TO_DRAFT.has(r);

/** How many speaker-tagged excerpts back this selection. Shape-tolerant on purpose — the evidence JSON has two historical shapes. */
function excerptCount(evidenceJson: string | null | undefined): number {
  if (!evidenceJson) return 0;
  try {
    const v: unknown = JSON.parse(evidenceJson);
    const arr = Array.isArray(v) ? v : (v as { excerpts?: unknown[] })?.excerpts;
    if (!Array.isArray(arr)) return 0;
    return arr.filter((x) => x && typeof (x as { text?: unknown }).text === "string" && (x as { text: string }).text.trim().length > 20).length;
  } catch {
    return 0;
  }
}

/**
 * What this month still owes in scripts, and why each one is or is not ready.
 * Pure read — safe on every render of the month workspace.
 */
export async function scriptWorkForMonth(monthId: string): Promise<ScriptWorkItem[]> {
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true, callRecordId: true, historical: true },
  });
  if (!month || month.historical) return [];
  // ContentMonth declares no relations, so the name is its own read.
  const client = await prisma.client.findUnique({ where: { id: month.clientId }, select: { name: true } });

  const selections = await prisma.contentTopicSelection.findMany({
    where: { monthId, status: { in: ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"] } },
    select: { topicId: true, status: true, callRecordId: true, evidenceJson: true, rank: true, createdAt: true },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
  });
  if (!selections.length) return [];

  const topicIds = selections.map((s) => s.topicId);
  const [topics, scripts, interviews] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }),
    // monthId is part of the identity: a bank-level script (monthId IS NULL) is
    // not this month's script, and a historical import is not a draft.
    prisma.contentScript.findMany({ where: { monthId, topicId: { in: topicIds }, historical: false }, select: { id: true, topicId: true } }),
    prisma.contentInterview.findMany({ where: { monthId, topicId: { in: topicIds } }, select: { id: true, topicId: true, status: true } }),
  ]);
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));
  const scriptOf = new Map(scripts.filter((s) => s.topicId).map((s) => [s.topicId as string, s.id]));
  const interviewOf = new Map(interviews.map((i) => [i.topicId, i]));

  return selections.map((sel): ScriptWorkItem => {
    const iv = interviewOf.get(sel.topicId) ?? null;
    const n = excerptCount(sel.evidenceJson);
    const scriptId = scriptOf.get(sel.topicId) ?? null;
    const base = {
      topicId: sel.topicId,
      title: titleOf.get(sel.topicId) ?? "(untitled topic)",
      monthId: month.id,
      monthKey: month.monthKey,
      enrollmentId: month.enrollmentId,
      clientId: month.clientId,
      clientName: client?.name ?? null,
      scriptId,
      interviewId: iv?.id ?? null,
      interviewStatus: iv?.status ?? null,
      callRecordId: sel.callRecordId ?? month.callRecordId ?? null,
      excerpts: n,
    };
    if (scriptId) return { ...base, readiness: "HAS_SCRIPT", why: "Drafted." };
    // A person has not yet said this is the month's plan.
    if (sel.status === "PROPOSED") {
      return { ...base, readiness: "WAITING_ON_PLANNING", why: "The call proposed this — it needs reconciling before we script it." };
    }
    // The client's own words beat every other input, so they are checked first.
    if (iv && (iv.status === "SUBMITTED" || iv.status === "SUFFICIENT")) {
      return { ...base, readiness: "FROM_ANSWERS", why: iv.status === "SUBMITTED" ? "Their answers are in." : "Their answers are sufficient." };
    }
    if (iv && (iv.status === "IN_PROGRESS" || iv.status === "NEEDS_FOLLOWUP")) {
      return {
        ...base,
        readiness: "WAITING_ON_ANSWERS",
        why: iv.status === "NEEDS_FOLLOWUP" ? "Their answers stop short of a script — one or two more would do it." : "They have started the questions and not finished.",
      };
    }
    if (n > 0) return { ...base, readiness: "FROM_CALL", why: `${n} excerpt${n === 1 ? "" : "s"} from the planning call back this topic.` };
    return { ...base, readiness: "THIN", why: "No answers and no call excerpts — a draft would be built from the topic line and the strategy alone." };
  });
}

export type DraftOutcome = {
  topicId: string;
  title: string;
  /** drafted · skipped (already claimed / not ready) · failed */
  result: "drafted" | "skipped" | "failed";
  readiness: ScriptReadiness;
  path?: "answers" | "topic";
  scriptId?: string;
  versionId?: string;
  gaps?: number;
  note?: string;
};

export type DraftOpts = {
  requestedBy: string;
  unattended: boolean;
  /** Draft topics with no answers and no excerpts too. A person's explicit ask only. */
  includeThin?: boolean;
  max?: number;
};

/**
 * Draft every script this month owes that has the evidence to be drafted.
 *
 * Concurrency: each generator claims its work through ProgramAiRun's unique
 * dedupeKey (`script:<topicId>:<monthId>` / `script:interview:<id>`), which
 * Postgres enforces — so two sweeps racing on the same topic produce one
 * script and one skip, not two scripts. No advisory lock needed and no claim
 * of our own to leak on a crash.
 */
export async function draftOwedScriptsForMonth(monthId: string, opts: DraftOpts): Promise<{ drafted: number; skipped: number; failed: number; outcomes: DraftOutcome[] }> {
  const work = await scriptWorkForMonth(monthId);
  const todo = work.filter((w) => (opts.includeThin ? w.readiness === "THIN" || isAutoDraftable(w.readiness) : isAutoDraftable(w.readiness)));
  const outcomes: DraftOutcome[] = [];
  const limit = opts.max ?? 8;

  for (const w of todo.slice(0, limit)) {
    try {
      if (w.readiness === "FROM_ANSWERS" && w.interviewId) {
        const { generateScriptFromInterview } = await import("@/lib/contentGeneration");
        const r = await generateScriptFromInterview(w.interviewId, opts.requestedBy, { unattended: opts.unattended });
        outcomes.push({ topicId: w.topicId, title: w.title, result: "drafted", readiness: w.readiness, path: "answers", scriptId: r.scriptId, versionId: r.versionId, gaps: r.gaps });
      } else {
        const { generateScriptForTopic } = await import("@/lib/contentGeneration");
        const r = await generateScriptForTopic({
          topicId: w.topicId,
          monthId: w.monthId,
          requestedBy: opts.requestedBy,
          unattended: opts.unattended,
          callRecordId: w.callRecordId,
          selectedOnCall: w.readiness === "FROM_CALL",
        });
        outcomes.push({ topicId: w.topicId, title: w.title, result: "drafted", readiness: w.readiness, path: "topic", scriptId: r.scriptId, versionId: r.versionId, gaps: r.gaps });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Losing the dedupe race is not a failure — somebody else is drafting it.
      const raced = /already (running|in progress)|Unique constraint|dedupe/i.test(msg);
      outcomes.push({ topicId: w.topicId, title: w.title, result: raced ? "skipped" : "failed", readiness: w.readiness, note: msg.slice(0, 300) });
      // An automation-disabled error means the switch went off mid-sweep: stop,
      // do not burn the rest of the month against a closed gate.
      if (e instanceof Error && e.name === "AutomationDisabledError") break;
    }
  }

  return {
    drafted: outcomes.filter((o) => o.result === "drafted").length,
    skipped: outcomes.filter((o) => o.result === "skipped").length,
    failed: outcomes.filter((o) => o.result === "failed").length,
    outcomes,
  };
}

/**
 * The hourly settlement of both planning paths, across every open month.
 *
 * Gated twice over: `script_drafting` here, `ai_runs` inside every generator.
 * Bounded by a wall clock as well as a count, because one month's drafts can
 * outlast a cron step on their own.
 */
export async function sweepOwedScripts(opts: { max?: number; budgetMs?: number; now?: Date } = {}): Promise<
  { skipped: string } | { months: number; drafted: number; skipped: number; failed: number; waiting: number; thin: number; detail: { monthKey: string; client: string | null; drafted: number; failed: number }[] }
> {
  if (!(await isAutomationEnabled("script_drafting"))) return { skipped: "script_drafting is off" };
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 90_000;
  const maxScripts = opts.max ?? 6;

  // Open months on live enrollments only. A paused or ended client is not owed
  // new work, and a historical month is a record, not a plan.
  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  const months = live.length
    ? await prisma.contentMonth.findMany({
        where: { historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] }, enrollmentId: { in: live.map((e) => e.id) } },
        select: { id: true, monthKey: true, clientId: true },
        orderBy: { monthKey: "desc" },
        take: 40,
      })
    : [];
  const names = new Map(
    (await prisma.client.findMany({ where: { id: { in: [...new Set(months.map((m) => m.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );

  let drafted = 0, skipped = 0, failed = 0, waiting = 0, thin = 0, touched = 0;
  const detail: { monthKey: string; client: string | null; drafted: number; failed: number }[] = [];
  let lastError: string | null = null;

  for (const m of months) {
    if (drafted >= maxScripts || Date.now() - started > budgetMs) break;
    let work: ScriptWorkItem[];
    try {
      work = await scriptWorkForMonth(m.id);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    waiting += work.filter((w) => w.readiness === "WAITING_ON_ANSWERS" || w.readiness === "WAITING_ON_PLANNING").length;
    thin += work.filter((w) => w.readiness === "THIN").length;
    const ready = work.filter((w) => isAutoDraftable(w.readiness));
    if (!ready.length) continue;
    touched++;
    const r = await draftOwedScriptsForMonth(m.id, { requestedBy: "cron", unattended: true, max: Math.max(1, maxScripts - drafted) });
    drafted += r.drafted;
    skipped += r.skipped;
    failed += r.failed;
    if (r.failed) lastError = r.outcomes.find((o) => o.result === "failed")?.note ?? lastError;
    if (r.drafted || r.failed) detail.push({ monthKey: m.monthKey, client: names.get(m.clientId) ?? null, drafted: r.drafted, failed: r.failed });
  }

  await recordAutomationRun("script_drafting", lastError).catch(() => {});
  return { months: touched, drafted, skipped, failed, waiting, thin, detail };
}

// ---------------------------------------------------------------------------
// THE QUESTIONS, PHRASED FOR THE TOPIC (F10) — the step BEFORE the answers.
//
// The interview row is only created when a client presses "Answer the
// questions", which is one moment too late to phrase them: by then they are
// reading question 1. So this runs ahead of them — for every topic a month has
// committed to, it opens the interview and has the model rewrite the six house
// questions for THAT topic, so the first thing the client sees is about
// pre-listing inspections rather than about "people in this situation".
//
// Creating the interview early changes nothing downstream: a NOT_STARTED
// interview is not "waiting on them" in scriptWorkForMonth — it falls through
// to the call-excerpt check exactly as a missing one did.
// ---------------------------------------------------------------------------
export async function sweepInterviewPlans(opts: { max?: number; budgetMs?: number } = {}): Promise<{ skipped: string } | { planned: number; alreadyPlanned: number; failed: number; lastError: string | null }> {
  if (!(await isAutomationEnabled("script_drafting"))) return { skipped: "script_drafting is off" };
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 45_000;
  const max = opts.max ?? 5;

  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!live.length) return { planned: 0, alreadyPlanned: 0, failed: 0, lastError: null };
  const months = await prisma.contentMonth.findMany({
    where: { historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] }, enrollmentId: { in: live.map((e) => e.id) } },
    select: { id: true },
    orderBy: { monthKey: "desc" },
    take: 40,
  });
  if (!months.length) return { planned: 0, alreadyPlanned: 0, failed: 0, lastError: null };

  // Committed topics only. A call's PROPOSED suggestion is not the month's plan,
  // and phrasing questions for a topic nobody has agreed to is spent credit.
  const selections = await prisma.contentTopicSelection.findMany({
    where: { monthId: { in: months.map((m) => m.id) }, status: { in: ["SELECTED", "RECONCILED"] } },
    select: { topicId: true, monthId: true },
    take: 200,
  });
  if (!selections.length) return { planned: 0, alreadyPlanned: 0, failed: 0, lastError: null };

  // Topics that already have this month's script need no questions.
  const scripted = new Set(
    (await prisma.contentScript.findMany({ where: { monthId: { in: months.map((m) => m.id) }, topicId: { in: selections.map((s) => s.topicId) }, historical: false }, select: { topicId: true, monthId: true } }))
      .map((r) => `${r.topicId}:${r.monthId}`),
  );

  const { getOrCreateInterview, interviewPlanningContext } = await import("@/lib/contentInterview");
  const { planInterviewQuestions } = await import("@/lib/contentGeneration");
  let planned = 0, alreadyPlanned = 0, failed = 0;
  let lastError: string | null = null;

  for (const sel of selections) {
    if (planned >= max || Date.now() - started > budgetMs) break;
    if (scripted.has(`${sel.topicId}:${sel.monthId}`)) continue;
    try {
      const interviewId = await getOrCreateInterview(sel.topicId, sel.monthId, {});
      const ctx = await interviewPlanningContext(interviewId);
      if (ctx.hasPlan) { alreadyPlanned++; continue; }
      await planInterviewQuestions(interviewId, { requestedBy: "cron", unattended: true });
      planned++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already (running|in progress)|Unique constraint|dedupe/i.test(msg)) { alreadyPlanned++; continue; }
      failed++;
      lastError = msg.slice(0, 300);
      if (e instanceof Error && e.name === "AutomationDisabledError") break;
    }
  }
  return { planned, alreadyPlanned, failed, lastError };
}
