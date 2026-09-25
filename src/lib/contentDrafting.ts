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
  /**
   * CP-08: the answers are in (or sent with gaps) and a script still cannot
   * exist from them — no premise, no stance or fewer than three points, even
   * counting the approved topic and the client's words on the call. Kyle
   * follows up; a person may still draft it on purpose.
   */
  | "THIN_ANSWERS"
  /** The call proposed it; no one has reconciled the month's plan yet. */
  | "WAITING_ON_PLANNING"
  /**
   * R01: beyond the month's allowance (planningState.allowanceOrder). Kept and
   * waiting its turn — never drafted by the sweep and never counted as owed
   * material. A person may still draft it on purpose, from the topic.
   */
  | "EXTRA";

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

  const planned = await prisma.contentTopicSelection.findMany({
    where: { monthId, status: { in: ["SELECTED", "RECONCILED", "PROPOSED", "CARRIED"] } },
    select: { topicId: true, status: true, callRecordId: true, evidenceJson: true, rank: true, createdAt: true },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
  });
  if (!planned.length) return [];
  // CP-07: a topic whose script was CARRIED OUT of this month (to a later one,
  // or parked by a swap) is this month's history, not a script it still owes.
  // Its selection here stays as it was — that WAS the plan — but counting it
  // as owed would show a phantom gap and let "draft what's owed" write a
  // second script for a topic that already has one.
  const carriedAway = new Set(
    (await prisma.contentScript.findMany({
      where: { topicId: { in: planned.map((s) => s.topicId) }, historical: false, carriedFromMonthId: monthId, OR: [{ monthId: null }, { monthId: { not: monthId } }] },
      select: { topicId: true },
    })).map((s) => s.topicId as string),
  );
  const selections = planned.filter((s) => !carriedAway.has(s.topicId));
  if (!selections.length) return [];

  const topicIds = selections.map((s) => s.topicId);
  // R01: the ONE planning reader — which of these are the allowance, and how
  // many scrubbed client/Jordan lines THIS month's call left for each (from
  // the selection's evidence, or a DISCUSSED event when the client had already
  // picked the topic in the portal). Unreadable → the old per-row count.
  const reader = await import("@/lib/planningFacts").then((m) => m.planningForMonth(monthId)).catch(() => null);
  const [topics, scripts, interviews] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }),
    // monthId is part of the identity: a bank-level script (monthId IS NULL) is
    // not this month's script, and a historical import is not a draft.
    prisma.contentScript.findMany({ where: { monthId, topicId: { in: topicIds }, historical: false }, select: { id: true, topicId: true } }),
    prisma.contentInterview.findMany({ where: { monthId, topicId: { in: topicIds } }, select: { id: true, topicId: true, status: true, sufficiencyJson: true } }),
  ]);
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));
  const scriptOf = new Map(scripts.filter((s) => s.topicId).map((s) => [s.topicId as string, s.id]));
  const interviewOf = new Map(interviews.map((i) => [i.topicId, i]));

  // SUFFICIENCY, ASKED — NOT A STATUS READ (CP-08). "SUBMITTED" used to be
  // drafted on sight, which is how an all-skipped interview was drafted from
  // the topic line: the header's own "never drafts from nothing" rule, broken
  // by the status it trusted. So a submitted interview drafts only when its
  // stored reading says sufficient (a legacy row with no reading is read
  // fresh), and an unfinished one drafts when the answers plus the client's
  // own words on the call already carry a script — the call path, without
  // anyone retyping the call as answers. The read is pure: nothing here moves
  // an interview's status.
  const { readInterviewSufficiency } = await import("@/lib/contentInterview");
  const storedSufficient = (json: string | null): boolean | null => {
    if (!json) return null;
    try { const v = JSON.parse(json) as { sufficient?: unknown }; return typeof v.sufficient === "boolean" ? v.sufficient : null; } catch { return null; }
  };
  const fresh = new Map<string, { ready: boolean; seedsFromCall: number }>();
  for (const iv of interviews) {
    const scripted = scriptOf.has(iv.topicId);
    const needsRead = !scripted && (iv.status === "IN_PROGRESS" || iv.status === "NEEDS_FOLLOWUP" || iv.status === "SUBMITTED_WITH_GAPS" || (iv.status === "SUBMITTED" && storedSufficient(iv.sufficiencyJson) === null));
    if (!needsRead) continue;
    const r = await readInterviewSufficiency(iv.id).catch(() => null);
    if (r) fresh.set(iv.id, { ready: r.ready, seedsFromCall: r.seedsFromCall });
  }

  return selections.map((sel): ScriptWorkItem => {
    const iv = interviewOf.get(sel.topicId) ?? null;
    const fact = reader?.facts.find((f) => f.topicId === sel.topicId) ?? null;
    const n = fact ? fact.callExcerpts : excerptCount(sel.evidenceJson);
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
    if (reader?.allowance.slots.get(sel.topicId) === "EXTRA") {
      return { ...base, readiness: "EXTRA", why: "An extra beyond this month's allowance — it waits its turn. Draft it from the topic if you want it now." };
    }
    // A person has not yet said this is the month's plan.
    if (sel.status === "PROPOSED") {
      return { ...base, readiness: "WAITING_ON_PLANNING", why: "The call proposed this — it needs reconciling before we script it." };
    }
    // The client's own words beat every other input, so they are checked first.
    const read = iv ? fresh.get(iv.id) ?? null : null;
    const fromCall = read && read.seedsFromCall > 0 ? ` (plus ${read.seedsFromCall} of their lines from the call)` : "";
    if (iv && iv.status === "SUBMITTED") {
      const ok = storedSufficient(iv.sufficiencyJson) ?? read?.ready ?? false;
      return ok
        ? { ...base, readiness: "FROM_ANSWERS", why: `Their answers are in${fromCall}.` }
        : { ...base, readiness: "THIN_ANSWERS", why: "Their answers were sent, but they stop short of a script — Kyle follows up before we draft." };
    }
    if (iv && iv.status === "SUFFICIENT") return { ...base, readiness: "FROM_ANSWERS", why: "Their answers are sufficient." };
    if (iv && iv.status === "SUBMITTED_WITH_GAPS") {
      return read?.ready
        ? { ...base, readiness: "FROM_ANSWERS", why: `Sent with gaps, and the call covers them${fromCall}.` }
        : { ...base, readiness: "THIN_ANSWERS", why: "Sent with gaps — not enough for a script yet; Kyle is following up." };
    }
    if (iv && (iv.status === "IN_PROGRESS" || iv.status === "NEEDS_FOLLOWUP")) {
      if (read?.ready) return { ...base, readiness: "FROM_ANSWERS", why: `Their answers so far and the call already carry a script${fromCall}.` };
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
  /** drafted · skipped (already claimed / not ready / the switch closed) · failed */
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
 *
 * The work list is read ONCE, and a walk can take minutes. A topic another
 * sweep drafted start to finish meanwhile is not "owed" any more, and the key
 * alone did not know (it was freed when that run's model call returned) — so
 * every generator here runs with onlyIfUnscripted: it re-checks right before
 * claiming, holds the key until the version is written, and never adds a
 * version to a script that exists. That skip is counted as raced, not failed
 * (Sep 24; cron-route-journey §4 drives it).
 */
export async function draftOwedScriptsForMonth(monthId: string, opts: DraftOpts): Promise<{ drafted: number; skipped: number; failed: number; paused: string | null; outcomes: DraftOutcome[] }> {
  const work = await scriptWorkForMonth(monthId);
  const todo = work.filter((w) => (opts.includeThin ? w.readiness === "THIN" || w.readiness === "THIN_ANSWERS" || isAutoDraftable(w.readiness) : isAutoDraftable(w.readiness)));
  const outcomes: DraftOutcome[] = [];
  const limit = opts.max ?? 8;
  let pausedBy: string | null = null;

  for (const w of todo.slice(0, limit)) {
    try {
      if ((w.readiness === "FROM_ANSWERS" || w.readiness === "THIN_ANSWERS") && w.interviewId) {
        const { generateScriptFromInterview } = await import("@/lib/contentGeneration");
        const r = await generateScriptFromInterview(w.interviewId, opts.requestedBy, { unattended: opts.unattended, onlyIfUnscripted: true });
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
          onlyIfUnscripted: true,
        });
        outcomes.push({ topicId: w.topicId, title: w.title, result: "drafted", readiness: w.readiness, path: "topic", scriptId: r.scriptId, versionId: r.versionId, gaps: r.gaps });
      }
      await noteOutcome(w, "drafted");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Losing the dedupe race is not a failure — somebody else is drafting it.
      // So is finding it drafted by the other run since this list was read.
      const raced = /already (running|in progress|drafted)|Unique constraint|dedupe/i.test(msg);
      // NEITHER IS A CLOSED SWITCH. `ai_runs` off is Jordan's stop button, and
      // the whole point of a stop button is that pressing it is not an incident.
      // Counted as a failure it became one: every hourly tick stamped lastError
      // on the script_drafting row and programMonitoring.ts turned that into
      // `Automation "script_drafting" last run failed`, retryable:false, on the
      // monitoring screen — hourly, for as long as the stop was held, burying
      // the real failures it exists to show. A refusal we asked for is a skip.
      const paused = e instanceof Error && e.name === "AutomationDisabledError";
      outcomes.push({ topicId: w.topicId, title: w.title, result: raced || paused ? "skipped" : "failed", readiness: w.readiness, note: msg.slice(0, 300) });
      if (!raced && !paused) await noteOutcome(w, "failed", msg);
      if (paused) { pausedBy = msg.slice(0, 300); break; }
    }
  }

  return {
    drafted: outcomes.filter((o) => o.result === "drafted").length,
    skipped: outcomes.filter((o) => o.result === "skipped").length,
    failed: outcomes.filter((o) => o.result === "failed").length,
    paused: pausedBy,
    outcomes,
  };
}

/**
 * 6.5 (Sep 25 2026): a draft that fails twice in a row for the same topic and
 * month becomes the scripts owner's task (programDeskTasks.noteDraftOutcome);
 * the next success closes it. Best-effort: the bookkeeping never turns a
 * drafted script into a failure, or a failure into a crash.
 */
async function noteOutcome(w: ScriptWorkItem, result: "drafted" | "failed", error?: string): Promise<void> {
  try {
    const { noteDraftOutcome } = await import("@/lib/programDeskTasks");
    await noteDraftOutcome({ topicId: w.topicId, monthId: w.monthId, monthKey: w.monthKey, enrollmentId: w.enrollmentId, clientId: w.clientId, clientName: w.clientName, title: w.title }, result, error ?? null);
  } catch { /* the desk task is a second signal; the outcome above is the record */ }
}

/**
 * The hourly settlement of both planning paths, across every open month.
 *
 * Gated twice over: `script_drafting` here, `ai_runs` inside every generator.
 * Bounded by a wall clock as well as a count, because one month's drafts can
 * outlast a cron step on their own.
 */
export async function sweepOwedScripts(opts: { max?: number; budgetMs?: number; now?: Date } = {}): Promise<
  { skipped: string } | { months: number; drafted: number; skipped: number; failed: number; waiting: number; thin: number; paused: string | null; detail: { monthKey: string; client: string | null; drafted: number; failed: number }[] }
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
  let paused: string | null = null;

  for (const m of months) {
    if (drafted >= maxScripts || Date.now() - started > budgetMs) break;
    let work: ScriptWorkItem[];
    try {
      work = await scriptWorkForMonth(m.id);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }
    waiting += work.filter((w) => w.readiness === "WAITING_ON_ANSWERS" || w.readiness === "WAITING_ON_PLANNING" || w.readiness === "THIN_ANSWERS").length;
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
    // The gate is global, not per-month: once it is closed every remaining
    // month would refuse in the same way. Stop, rather than walking forty
    // months to collect forty identical refusals.
    if (r.paused) { paused = r.paused; break; }
  }

  // `paused` is deliberately NOT passed as the error: a stop Jordan asked for
  // must not light up the monitoring screen as a fault. lastError still carries
  // a real one, and a clean run still clears it.
  await recordAutomationRun("script_drafting", lastError).catch(() => {});
  return { months: touched, drafted, skipped, failed, waiting, thin, paused, detail };
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
export async function sweepInterviewPlans(opts: { max?: number; budgetMs?: number } = {}): Promise<{ skipped: string } | { planned: number; alreadyPlanned: number; failed: number; paused: string | null; lastError: string | null }> {
  if (!(await isAutomationEnabled("script_drafting"))) return { skipped: "script_drafting is off" };
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? 45_000;
  const max = opts.max ?? 5;

  const live = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true } });
  if (!live.length) return { planned: 0, alreadyPlanned: 0, failed: 0, paused: null, lastError: null };
  const months = await prisma.contentMonth.findMany({
    where: { historical: false, status: { notIn: ["CLOSED", "CANCELLED", "IMPORTED"] }, enrollmentId: { in: live.map((e) => e.id) } },
    select: { id: true },
    orderBy: { monthKey: "desc" },
    take: 40,
  });
  if (!months.length) return { planned: 0, alreadyPlanned: 0, failed: 0, paused: null, lastError: null };

  // Committed topics only. A call's PROPOSED suggestion is not the month's plan,
  // and phrasing questions for a topic nobody has agreed to is spent credit.
  const selections = await prisma.contentTopicSelection.findMany({
    where: { monthId: { in: months.map((m) => m.id) }, status: { in: ["SELECTED", "RECONCILED"] } },
    select: { topicId: true, monthId: true },
    take: 200,
  });
  if (!selections.length) return { planned: 0, alreadyPlanned: 0, failed: 0, paused: null, lastError: null };

  // Topics that already have this month's script need no questions — and
  // neither does a month a topic's script was carried OUT of (CP-07).
  const scriptRows = await prisma.contentScript.findMany({
    where: { topicId: { in: selections.map((s) => s.topicId) }, historical: false, OR: [{ monthId: { in: months.map((m) => m.id) } }, { carriedFromMonthId: { in: months.map((m) => m.id) } }] },
    select: { topicId: true, monthId: true, carriedFromMonthId: true },
  });
  const scripted = new Set(scriptRows.flatMap((r) => [`${r.topicId}:${r.monthId}`, ...(r.carriedFromMonthId ? [`${r.topicId}:${r.carriedFromMonthId}`] : [])]));
  // R01: no questions phrased (and no credit spent) for a topic nobody will be
  // asked about: an extra waiting its turn, a topic the booked call will cover,
  // one whose material is already in, or one already being scripted.
  const NO_QUESTIONS = new Set(["EXTRA", "ON_CALL", "WRITING", "TEAM_REVIEW"]);
  const readers = await import("@/lib/planningFacts").then((m) => m.planningFactsForMonths([...new Set(selections.map((x) => x.monthId))])).catch(() => null);
  const stepOf = (topicId: string, monthId: string) => readers?.get(monthId)?.planning.topics.find((t) => t.topicId === topicId)?.step ?? null;

  const { getOrCreateInterview, interviewPlanningContext } = await import("@/lib/contentInterview");
  const { planInterviewQuestions } = await import("@/lib/contentGeneration");
  let planned = 0, alreadyPlanned = 0, failed = 0;
  let lastError: string | null = null;
  let paused: string | null = null;

  for (const sel of selections) {
    if (planned >= max || Date.now() - started > budgetMs) break;
    if (scripted.has(`${sel.topicId}:${sel.monthId}`)) continue;
    const step = stepOf(sel.topicId, sel.monthId);
    if (step && NO_QUESTIONS.has(step)) continue;
    try {
      const interviewId = await getOrCreateInterview(sel.topicId, sel.monthId, {});
      const ctx = await interviewPlanningContext(interviewId);
      if (ctx.hasPlan) { alreadyPlanned++; continue; }
      await planInterviewQuestions(interviewId, { requestedBy: "cron", unattended: true });
      planned++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already (running|in progress)|Unique constraint|dedupe/i.test(msg)) { alreadyPlanned++; continue; }
      // Same rule as the drafting sweep: a closed switch is not a failure.
      if (e instanceof Error && e.name === "AutomationDisabledError") { paused = msg.slice(0, 300); break; }
      failed++;
      lastError = msg.slice(0, 300);
    }
  }
  return { planned, alreadyPlanned, failed, paused, lastError };
}
