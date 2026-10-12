import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthDay } from "@/lib/datetime";
import { contentHref } from "@/lib/contentNav";
import { transcriptSourceWords } from "@/lib/programCallEvidence";
import { enqueueTranscriptJob, holdReasonFor, transcriptHoldContext, transcriptJobDedupeKey } from "@/lib/transcriptJobs";
import { readTranscript } from "@/lib/integrations/googleDrive";

// ---------------------------------------------------------------------------
// A CALL'S TRANSCRIPT, FIRST-CLASS ON THE MONTH (Oct 12 2026).
//
// Jordan: "I had a call with Janice Pigga and a call with John Collins last
// week, but I don't see that they came through on the content program
// platform." They had: the Drive "Notes by Gemini" docs were found and
// confirmed on each call record, and an INGEST + ANALYZE job queued. But every
// automation switch was off, the rollout kept internal AI to TEST clients, and
// the month's call card only read the month's own pasted transcript — so it
// said "Paste the transcript" over a call whose transcript was in, and nothing
// anywhere said the analysis was waiting, or why.
//
// This module is the one reader and the one attended path:
//
//   loadCallTranscripts   every call's transcript state in plain words — none
//                         yet / in, not analyzed / analyzing / analyzed (N topic
//                         proposals) / failed — and, for one that is in but not
//                         analyzed, WHY the automatic run has not done it (the
//                         switches, the backlog cutoff, a failed or retrying
//                         run), from the queue's own hold rule. Read-only.
//
//   startCallAnalysis +   a person's "Analyze the call": the SAME analysis the
//   runClaimedCallAnalysis  ANALYZE job runs (contentGeneration's
//                         analyzeTranscriptText / analyzeDiscoveryKnowledge over
//                         the call's CONFIRMED sources — topics, answers, facts,
//                         script inputs as PROPOSALS for staff review, nothing
//                         client-visible), ATTENDED: it runs now whatever the
//                         switches say (aiRuns.runAiJson gates unattended runs
//                         only). The call's ANALYZE job row is the claim, so a
//                         click and the hourly processor can never analyse the
//                         same call twice at once; on success the job is
//                         SUCCEEDED and the processor has nothing left to do.
//                         Re-analyze runs it again: topics a person already
//                         confirmed, removed or rejected stay exactly as they
//                         are (contentTopics.selectTopicForMonth).
//
// The month's legacy paste path (ContentMonth.transcriptText →
// contentPipeline.processMonthTranscript) is untouched and still works.
// ---------------------------------------------------------------------------

/** What a click may analyse: the two call types the queue's handler knows. */
const ANALYZABLE = new Set(["MONTHLY_STRATEGY", "BRAND_DISCOVERY"]);
const VERIFIED = new Set(["MATCHED", "CONFIRMED_BY_STAFF"]);
const LEASE_MS = 10 * 60_000;
/** The prefix an attended failure leaves on the job, so the reader can say it. */
export const ANALYZE_NOW_FAILED = "Analyze now failed";

export type CallTranscriptState = "none" | "in" | "analyzing" | "analyzed" | "failed" | "review";

export type CallTranscriptUi = {
  callRecordId: string;
  enrollmentId: string | null;
  clientId: string | null;
  clientName: string | null;
  monthKey: string | null;
  callType: string;
  /** "Strategy call" · "Brand discovery call" · "Call" */
  callWord: string;
  whenISO: string | null;
  /** The booked time has passed (or the record says COMPLETED). */
  held: boolean;
  /**
   *   none       no transcript on file yet
   *   in         a confirmed transcript, not analyzed yet
   *   analyzing  a run holds the call right now
   *   analyzed   its proposals are on the client file
   *   failed     the last run failed — Analyze tries again
   *   review     the transcript itself needs a person first (not confirmed, a stub, an import failure)
   */
  state: CallTranscriptState;
  /** "Transcript in from Drive (Gemini notes, Oct 6)" — null when there is none. */
  sourceLine: string | null;
  sourceUrl: string | null;
  /** "Analyzed Oct 12 — 4 topic proposals · 3 facts to review" */
  resultLine: string | null;
  proposals: number | null;
  /** For "in": why the AUTOMATIC run has not analysed it, in one sentence. */
  autoLine: string | null;
  /** For "none"/"review": what has to happen first. */
  waitLine: string | null;
  error: string | null;
  /** The button may run (the call is analysable and its client is confirmed). */
  canAnalyze: boolean;
  /** Why the button cannot run, when it cannot. */
  blocked: string | null;
  /** Where this call's card lives (the month's Plan › Calls, or Plan › Strategy for discovery). */
  href: string | null;
};

const CALL_WORD: Record<string, string> = { MONTHLY_STRATEGY: "Strategy call", BRAND_DISCOVERY: "Brand discovery call" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "Automatic analysis is off — Settings → Automations: Transcript processing + AI runs." */
export function automaticOffLine(processorOn: boolean, aiRunsOn: boolean): string | null {
  const off = [!processorOn ? "Transcript processing" : null, !aiRunsOn ? "AI runs" : null].filter(Boolean);
  return off.length ? `Automatic analysis is off — Settings → Automations: ${off.join(" + ")}.` : null;
}

type CallRow = {
  id: string; callType: string; status: string; matchState: string; transcriptState: string; analysisRunId: string | null; analysisJson: string | null;
  clientId: string | null; enrollmentId: string | null; monthId: string | null; targetMonthKey: string | null;
  scheduledStart: Date | null; scheduledEnd: Date | null; lastError: string | null; rawJson: string | null;
};
const CALL_SELECT = {
  id: true, callType: true, status: true, matchState: true, transcriptState: true, analysisRunId: true, analysisJson: true,
  clientId: true, enrollmentId: true, monthId: true, targetMonthKey: true, scheduledStart: true, scheduledEnd: true, lastError: true, rawJson: true,
} as const;

/**
 * Every call the filter names, with its transcript in plain words. Read-only:
 * no pin, no mark, no claim. One read per table, whatever the number of calls.
 *   monthId       the month's calls (filed on it), cancelled and set-aside ones left out
 *   callRecordIds exactly these
 *   awaiting      calls whose transcript is in and not analyzed (Settings' list)
 */
export async function loadCallTranscripts(
  filter: { monthId?: string; callRecordIds?: string[]; awaiting?: boolean; take?: number },
  now: Date = new Date(),
): Promise<CallTranscriptUi[]> {
  const where = filter.callRecordIds
    ? { id: { in: filter.callRecordIds } }
    : filter.monthId
      ? { monthId: filter.monthId, status: { notIn: ["CANCELLED", "RESCHEDULED"] }, matchState: { not: "IGNORED" } }
      : filter.awaiting
        ? { transcriptState: "CONFIRMED", status: { notIn: ["CANCELLED", "RESCHEDULED"] }, matchState: { not: "IGNORED" } }
        : null;
  if (!where) return [];
  const calls: CallRow[] = await prisma.programCallRecord.findMany({
    where, orderBy: { scheduledStart: filter.awaiting && !filter.monthId && !filter.callRecordIds ? "desc" : "asc" },
    take: filter.take ?? (filter.callRecordIds ? filter.callRecordIds.length : 60), select: CALL_SELECT,
  });
  if (!calls.length) return [];
  const ids = calls.map((c) => c.id);
  const [sources, withWords, jobs, runs, months, clients, hold] = await Promise.all([
    prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: ids } }, orderBy: [{ version: "desc" }, { createdAt: "desc" }], select: { id: true, callRecordId: true, provider: true, recordedAt: true, sourceUrl: true, matchState: true, externalId: true } }),
    prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: ids }, matchState: "CONFIRMED", text: { not: null } }, select: { id: true } }),
    prisma.programTranscriptJob.findMany({ where: { callRecordId: { in: ids }, kind: { in: ["INGEST", "ANALYZE"] } }, orderBy: { updatedAt: "desc" }, select: { id: true, callRecordId: true, kind: true, state: true, attempts: true, createdAt: true, lastError: true, reviewReason: true, leaseUntil: true, leaseBy: true, nextAttemptAt: true, finishedAt: true, aiRunId: true } }),
    prisma.programAiRun.findMany({ where: { id: { in: calls.map((c) => c.analysisRunId).filter((x): x is string => !!x) } }, select: { id: true, finishedAt: true, createdAt: true } }),
    prisma.contentMonth.findMany({ where: { id: { in: calls.map((c) => c.monthId).filter((x): x is string => !!x) } }, select: { id: true, monthKey: true } }),
    prisma.client.findMany({ where: { id: { in: calls.map((c) => c.clientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    transcriptHoldContext(now).catch(() => null),
  ]);
  const worded = new Set(withWords.map((s) => s.id));
  const monthKeyOf = new Map(months.map((m) => [m.id, m.monthKey]));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const out: CallTranscriptUi[] = [];
  for (const c of calls) {
    const confirmed = sources.filter((s) => s.callRecordId === c.id && s.matchState === "CONFIRMED");
    const candidates = sources.filter((s) => s.callRecordId === c.id && s.matchState === "CANDIDATE");
    const src = confirmed[0] ?? null;
    const analyze = jobs.find((j) => j.callRecordId === c.id && j.kind === "ANALYZE") ?? null;
    const held = c.status === "COMPLETED" || (!!(c.scheduledEnd ?? c.scheduledStart) && (c.scheduledEnd ?? c.scheduledStart)!.getTime() < now.getTime());
    const monthKey = (c.monthId ? monthKeyOf.get(c.monthId) : null) ?? c.targetMonthKey ?? null;
    const discovery = c.callType === "BRAND_DISCOVERY";
    const href = c.enrollmentId
      ? discovery ? contentHref(c.enrollmentId, { tab: "plan", view: "strategy", now }) : contentHref(c.enrollmentId, { tab: "plan", view: "calls", month: monthKey, now, anchor: "call" })
      : null;
    const liveLease = analyze?.state === "RUNNING" && !!analyze.leaseUntil && analyze.leaseUntil.getTime() > now.getTime();
    const analyzed = c.transcriptState === "ANALYZED" || (!!c.analysisRunId && c.transcriptState !== "CONFIRMED");
    const hasWords = confirmed.some((s) => worded.has(s.id) || (s.provider === "drive" && !!s.externalId));
    const attendedFail = analyze?.lastError?.startsWith(ANALYZE_NOW_FAILED) ? analyze.lastError : null;

    // What the button may do.
    let blocked: string | null = null;
    if (!ANALYZABLE.has(c.callType)) blocked = "Set what this call is first (Content → Strategy calls) — only a strategy or brand discovery call is analyzed.";
    else if (!c.clientId || !c.enrollmentId || !VERIFIED.has(c.matchState)) blocked = "Confirm whose call this is first (Content → Strategy calls, or the call review queue).";
    else if (!confirmed.length) blocked = "No transcript is confirmed on this call yet.";
    else if (!hasWords) blocked = "The transcript has no words on file — paste it instead.";

    let state: CallTranscriptState;
    let waitLine: string | null = null;
    if (liveLease) state = "analyzing";
    else if (analyzed && !attendedFail) state = "analyzed";
    else if (analyzed) state = "failed";
    else if (c.transcriptState === "CONFIRMED" && confirmed.length) {
      const jobFailed = analyze && (analyze.state === "FAILED" || analyze.state === "NEEDS_REVIEW");
      state = attendedFail || jobFailed ? "failed" : "in";
    } else if (c.transcriptState === "NEEDS_REVIEW" || c.transcriptState === "FAILED") {
      state = "review";
      waitLine = c.transcriptState === "FAILED" ? `The transcript import failed${c.lastError ? ` (${c.lastError.slice(0, 120)})` : ""} — fix it in the call review queue.` : "The transcript needs a person before it can be used — open the call review queue.";
    } else if (c.transcriptState === "CANDIDATES" || candidates.length) {
      state = "review";
      waitLine = "A possible transcript was found — confirm it belongs to this call in the call review queue.";
    } else {
      state = "none";
      waitLine = !held ? "The transcript comes in after the call." : "No transcript has come in yet — the Drive sweep looks for the Gemini notes every hour, or paste one.";
    }

    // Why the AUTOMATIC run has not done it — the queue's own hold rule.
    let autoLine: string | null = null;
    if (state === "in" || state === "failed") {
      if (!analyze) {
        let skipped: string | null = null;
        try { skipped = (JSON.parse(c.rawJson ?? "{}") as { analysis?: { skipped?: string } }).analysis?.skipped ?? null; } catch { skipped = null; }
        autoLine = skipped ? "Not queued: the old analyzer already read this transcript on the month." : "Not queued for automatic analysis.";
      } else if (analyze.state === "QUEUED") {
        const off = hold ? automaticOffLine(hold.processorOn, hold.aiRunsOn) : "Whether automatic analysis is on could not be read just now.";
        const h = hold ? holdReasonFor({ kind: "ANALYZE", createdAt: analyze.createdAt, attempts: analyze.attempts }, hold.ctx) : null;
        if (off) autoLine = off;
        else if (h?.kind === "backlog") autoLine = `Automatic analysis skips it: it was queued ${etMonthDay(analyze.createdAt)}, before Transcript processing was first switched on. Include older jobs in Settings → Calendly & calls, or analyze it now.`;
        else if (h) autoLine = h.reason.replace(/^waiting: /, "Waiting: ");
        else if (analyze.nextAttemptAt && analyze.nextAttemptAt.getTime() > now.getTime()) autoLine = `The automatic run tries again around ${analyze.nextAttemptAt.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET.`;
        else autoLine = "Queued — the next hourly run picks it up.";
      } else if (analyze.state === "RUNNING") autoLine = "The last run stopped before it finished — analyze it again.";
      else if (analyze.state === "CANCELLED") autoLine = "The automatic run was cancelled.";
    }

    // The result, once analysed.
    let resultLine: string | null = null;
    let proposals: number | null = null;
    if (analyzed) {
      let r: { proposedSelections?: number; keptSelections?: number; discussed?: number; bankIdeas?: number; facts?: number; proposals?: number } = {};
      try { r = JSON.parse(c.analysisJson ?? "{}"); } catch { r = {}; }
      const run = c.analysisRunId ? runOf.get(c.analysisRunId) : null;
      const at = run?.finishedAt ?? run?.createdAt ?? null;
      proposals = discovery ? r.bankIdeas ?? 0 : r.proposedSelections ?? 0;
      const parts = [discovery ? plural(proposals, "topic idea") + " for the bank" : plural(proposals, "topic proposal")];
      if (!discovery && r.keptSelections) parts.push(`${r.keptSelections} already decided, kept`);
      if (r.facts) parts.push(`${plural(r.facts, "fact")} to review`);
      if (r.proposals) parts.push(plural(r.proposals, "strategy proposal"));
      resultLine = `Analyzed${at ? ` ${etMonthDay(at)}` : ""} — ${parts.join(" · ")}`;
    }

    const error = attendedFail
      ?? (analyze && (analyze.state === "FAILED" || analyze.state === "NEEDS_REVIEW") ? `The automatic run ${analyze.state === "FAILED" ? "failed" : "stopped for a person"}: ${(analyze.reviewReason ?? analyze.lastError ?? "no reason recorded").slice(0, 200)}` : null);

    out.push({
      callRecordId: c.id, enrollmentId: c.enrollmentId, clientId: c.clientId, clientName: c.clientId ? nameOf.get(c.clientId) ?? null : null,
      monthKey, callType: c.callType, callWord: CALL_WORD[c.callType] ?? "Call",
      whenISO: c.scheduledStart?.toISOString() ?? null, held,
      state,
      sourceLine: src ? transcriptSourceWords(src, c.scheduledStart) : null,
      sourceUrl: src?.sourceUrl ?? null,
      resultLine, proposals,
      autoLine, waitLine, error,
      canAnalyze: !blocked && state !== "analyzing" && state !== "none" && state !== "review",
      blocked: state === "none" || state === "review" ? null : blocked,
      href,
    });
  }
  return out;
}

/**
 * Settings' list: every call whose transcript is in and not analyzed yet (or
 * whose last run failed), newest first, and — when it is the reason — the one
 * sentence that says automatic analysis is off. Read-only.
 */
export async function awaitingAnalysis(now: Date = new Date()): Promise<{ calls: CallTranscriptUi[]; offLine: string | null }> {
  const [calls, hold] = await Promise.all([loadCallTranscripts({ awaiting: true, take: 40 }, now), transcriptHoldContext(now).catch(() => null)]);
  return {
    calls: calls.filter((c) => c.state === "in" || c.state === "failed" || c.state === "analyzing"),
    offLine: hold ? automaticOffLine(hold.processorOn, hold.aiRunsOn) : "Whether automatic analysis is on could not be read just now.",
  };
}

// ---------------------------------------------------------------------------
// THE ATTENDED RUN — claim, then work.
// ---------------------------------------------------------------------------

export type StartResult =
  | { ok: true; jobId: string; reanalyze: boolean; prior: string; enrollmentId: string; monthKey: string | null }
  | { ok: false; message: string };

/**
 * Claim one call for a person's "Analyze the call". Fast and database-only, so
 * the click answers at once; the AI work is runClaimedCallAnalysis, handed to
 * after() by the action. The claim is the call's ANALYZE job row: QUEUED,
 * SUCCEEDED (re-analyze), FAILED, NEEDS_REVIEW, CANCELLED, or a RUNNING row
 * whose lease ran out → RUNNING under this person's lease. A live lease (the
 * hourly processor, or another click) refuses. No attempt is counted: an
 * attended try never uses up the automatic run's three.
 */
export async function startCallAnalysis(callRecordId: string, by: string, now: Date = new Date()): Promise<StartResult> {
  const call = await prisma.programCallRecord.findUnique({ where: { id: callRecordId }, select: CALL_SELECT });
  if (!call) return { ok: false, message: "That call is not on file any more." };
  if (call.status === "CANCELLED" || call.status === "RESCHEDULED") return { ok: false, message: "That booking was cancelled — there is no call to analyze." };
  if (!ANALYZABLE.has(call.callType)) return { ok: false, message: "Only a strategy or brand discovery call is analyzed — set what this call is first (Content → Strategy calls)." };
  if (!call.clientId || !call.enrollmentId || !VERIFIED.has(call.matchState)) return { ok: false, message: "Confirm whose call this is first (Content → Strategy calls, or the call review queue)." };
  const confirmed = await prisma.programTranscriptSource.findMany({ where: { callRecordId, matchState: "CONFIRMED" }, select: { id: true, provider: true, externalId: true, text: true } });
  if (!confirmed.length) return { ok: false, message: "No transcript is confirmed on this call yet." };
  if (!confirmed.some((s) => (s.text ?? "").trim().length > 0 || (s.provider === "drive" && !!s.externalId))) return { ok: false, message: "The transcript has no words on file — paste it instead." };

  const dedupeKey = transcriptJobDedupeKey("ANALYZE", callRecordId);
  let job = await prisma.programTranscriptJob.findUnique({ where: { dedupeKey }, select: { id: true, state: true, leaseUntil: true } });
  if (!job) {
    const q = await enqueueTranscriptJob({ callRecordId, kind: "ANALYZE", enrollmentId: call.enrollmentId, requestedBy: by });
    job = { id: q.id, state: q.state, leaseUntil: null };
  }
  if (job.state === "RUNNING" && job.leaseUntil && job.leaseUntil.getTime() > now.getTime()) {
    return { ok: false, message: "It is being analyzed right now — give it a minute." };
  }
  const claim = await prisma.programTranscriptJob.updateMany({
    where: { id: job.id, OR: [{ state: { in: ["QUEUED", "SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"] } }, { state: "RUNNING", leaseUntil: { lt: now } }, { state: "RUNNING", leaseUntil: null }] },
    data: { state: "RUNNING", leaseBy: `attended:${by}`, leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now, finishedAt: null, nextAttemptAt: null, reviewReason: null, requestedBy: by },
  });
  if (claim.count === 0) return { ok: false, message: "It is being analyzed right now — give it a minute." };
  const monthKey = call.monthId ? (await prisma.contentMonth.findUnique({ where: { id: call.monthId }, select: { monthKey: true } }))?.monthKey ?? null : call.targetMonthKey;
  return { ok: true, jobId: job.id, reanalyze: call.transcriptState === "ANALYZED" || job.state === "SUCCEEDED", prior: job.state === "RUNNING" ? "QUEUED" : job.state, enrollmentId: call.enrollmentId, monthKey };
}

/**
 * The work behind a claim: the words (exported from Drive when a confirmed
 * source has none yet — INGEST's own step), then the analysis the ANALYZE job
 * runs, attended. Never throws: the outcome lands on the job and the call.
 *   success → call ANALYZED with analysisRunId/analysisJson; job SUCCEEDED
 *             (aiRunId, resultJson marked attended); a waiting INGEST is done
 *   failure → the job goes back to where it was (a re-analyze leaves the
 *             earlier analysis standing) with "Analyze now failed …" on it
 */
export async function runClaimedCallAnalysis(claim: { jobId: string; callRecordId: string; by: string; prior: string }): Promise<{ ok: true; runId: string; proposals: number } | { ok: false; message: string }> {
  const { jobId, callRecordId, by, prior } = claim;
  const lease = `attended:${by}`;
  const heartbeat = async () => { await prisma.programTranscriptJob.updateMany({ where: { id: jobId, leaseBy: lease }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {}); };
  try {
    await ensureTranscriptWords(callRecordId);
    await heartbeat();
    const gen = await import("@/lib/contentGeneration");
    const ct = await gen.callAndTranscript({ id: jobId, kind: "ANALYZE", callRecordId, transcriptSourceId: null, requestedBy: by });
    if ("error" in ct) throw new Error(ct.error);
    if ("reviewReason" in ct) throw new Error(ct.reviewReason);
    if ("waiting" in ct) throw new Error(ct.waiting);
    const { call, text, enrollment, month, sourceId } = ct;
    let runId: string;
    let proposals: number;
    let result: Record<string, unknown>;
    if (call.callType === "BRAND_DISCOVERY") {
      const r = await gen.analyzeDiscoveryKnowledge({ enrollmentId: enrollment.id, clientId: enrollment.clientId, transcript: text, callRecordId: call.id, transcriptSourceId: sourceId, callDate: call.scheduledStart, requestedBy: by, unattended: false });
      runId = r.runId; proposals = r.bankIdeas; result = { ...r };
    } else {
      if (!month) throw new Error("Month not found.");
      const r = await gen.analyzeTranscriptText({ enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: month.id, monthKey: month.monthKey, transcript: text, callDate: call.scheduledStart, videosOwed: month.videosOwed, requestedBy: by, unattended: false, callRecordId: call.id, transcriptSourceId: sourceId });
      runId = r.runId; proposals = r.proposedSelections; result = { ...r };
    }
    const finishedAt = new Date();
    await prisma.programCallRecord.update({ where: { id: call.id }, data: { analysisRunId: runId, transcriptState: "ANALYZED", analysisJson: JSON.stringify(result), ...(call.lastError?.startsWith("ANALYZE:") ? { lastError: null, lastErrorAt: null } : {}) } });
    await prisma.programTranscriptJob.updateMany({
      where: { id: jobId, leaseBy: lease },
      data: { state: "SUCCEEDED", finishedAt, leaseUntil: null, leaseBy: null, lastError: null, lastErrorAt: null, reviewReason: null, aiRunId: runId, resultJson: JSON.stringify({ ...result, attended: true, by }) },
    });
    return { ok: true, runId, proposals };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 400) || "unknown error";
    const at = new Date();
    await prisma.programTranscriptJob.updateMany({
      where: { id: jobId, leaseBy: lease },
      data: { state: prior, leaseUntil: null, leaseBy: null, startedAt: null, lastError: `${ANALYZE_NOW_FAILED} (${etMonthDay(at)}): ${msg}`.slice(0, 1000), lastErrorAt: at, ...(prior === "SUCCEEDED" ? {} : { finishedAt: null }) },
    }).catch(() => {});
    return { ok: false, message: msg };
  }
}

/**
 * INGEST's step, for a click: a confirmed Drive source with no words yet is
 * exported now, and a waiting INGEST job on the call is closed once every
 * confirmed source has real words (≥ 200 characters), so the queue does not
 * pull them a second time. A stub refuses, as INGEST would.
 */
async function ensureTranscriptWords(callRecordId: string): Promise<void> {
  const sources = await prisma.programTranscriptSource.findMany({ where: { callRecordId, matchState: "CONFIRMED" }, select: { id: true, provider: true, externalId: true, text: true } });
  let good = 0;
  for (const s of sources) {
    let text = s.text;
    if (!text && s.provider === "drive" && s.externalId) {
      text = (await readTranscript(s.externalId)).trim().slice(0, 500_000);
      await prisma.programTranscriptSource.update({ where: { id: s.id }, data: { text } });
    }
    if ((text ?? "").length >= 200) good++;
  }
  if (!good) throw new Error("The transcript is empty or a stub (under 200 characters) — paste the real one.");
  if (good === sources.length) {
    await prisma.programTranscriptJob.updateMany({
      where: { callRecordId, kind: "INGEST", state: { in: ["QUEUED", "FAILED", "NEEDS_REVIEW"] } },
      data: { state: "SUCCEEDED", finishedAt: new Date(), leaseUntil: null, leaseBy: null, lastError: null, lastErrorAt: null, resultJson: JSON.stringify({ attended: true, sources: good }) },
    });
  }
}
