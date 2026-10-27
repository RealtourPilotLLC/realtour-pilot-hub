import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE AI WORK JOB (every 15 minutes — see vercel.json). The path and the job
// name stay "topics" (the CronRun rows and /connections key on the last path
// segment); what it hosts is every unattended model call the program makes.
//
// Oct 13 2026, first: CP-07's topic banks. One refresh takes 45–60 seconds (a
// whole bank longer), and squeezed into the end of the hourly sync the second
// run of a tick always started with seconds left, the server stopped it
// mid-call and it read "AI run topic_refresh failed — lease expired" on every
// client's card (Jordan: "Everyone's topic idea refreshes have failed").
//
// Oct 13 2026, later the same day: the rest of the hourly sync's AI work moved
// here for the same reason (Jordan approved B6). The transcript queue, the AI
// queue's safety net and the script-drafting sweep each STARTED a model call
// whenever any of their budget remained, and between them they took up to
// three minutes of the sync's 250 s, crowding the client texts and everything
// after them. Here:
//   · nothing else shares the run — the hourly sync is model-free again;
//   · EVERY call starts only with the time to finish it (minStartMs, checked
//     before each job, draft, question set and refresh, not once per step);
//   · the run's own clock is the budget: each step gets what is left of it,
//     less a margin, so a call that started in time ends before the platform's
//     300 s ceiling;
//   · the AI queue (a person's click carried out later) goes first; the other
//     three take turns going first, so a long backlog in one cannot starve
//     the others four ticks an hour.
// Every step keeps its own switch (`ai_runs` under each): off = `skipped`.
//
// Oct 16 2026: second in every run, after the AI queue, the net under the
// revision work order (revisionBriefs): a client's change request whose
// reading failed is read again here.
// ---------------------------------------------------------------------------

/** The run stops starting steps here (300 s ceiling): 20 s for finish() and the response. */
const RUN_BUDGET_MS = 280_000;
/** What each step leaves unspent of the run's budget, so a call that started in
 *  time — and runs a little long — still ends before the run's own budget, and
 *  the steps after it are never `skipped` (a skip pages Jordan). */
const MARGIN_MS = 25_000;
/** A queued draft (script, revision, strategy) is one model call; a worker claims one only with this long left. */
const AI_QUEUE_MIN_START_MS = 90_000;
/** A topic refresh is 45–60 s, a whole bank longer. */
const TOPIC_REFRESH_MIN_START_MS = 150_000;
/** At most two refreshes fit one run (Oct 13 2026: it was 3, which the budget could never reach): the first at 0 s, the second while 150 s of the ~255 s remain. */
const TOPIC_REFRESH_MAX = 2;

/** The three unattended sweeps, in the order a tick with index 0 runs them. */
const AI_WORK_ROTATION = ["transcriptJobs", "scriptDrafting", "topicBanks"] as const;
type AiWorkStep = (typeof AI_WORK_ROTATION)[number];

/** Which sweep goes first this tick: a quarter-hour counter, so each leads in turn. */
function aiWorkOrder(startedAtMs: number): AiWorkStep[] {
  const shift = Math.floor(startedAtMs / (15 * 60_000)) % AI_WORK_ROTATION.length;
  return [...AI_WORK_ROTATION.slice(shift), ...AI_WORK_ROTATION.slice(0, shift)];
}

export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const startedAt = Date.now();
  const { step, out, finish, remaining } = cronBudget(RUN_BUDGET_MS, startedAt, "topics");
  const budget = () => Math.max(0, remaining() - MARGIN_MS);

  // A person's queued click first (Oct 12 2026): the page's own worker normally
  // runs it at once; this drains what a killed worker or a closed page left.
  // Attended work — no automation switch gates it; the queue's cap of three and
  // the daily AI quotas still hold. Two per worker at most, so a long queue
  // cannot take the whole run from the sweeps below.
  await step("aiQueue", async () => {
    const { drainAiQueueInParallel } = await import("@/lib/aiQueue");
    return drainAiQueueInParallel({ origin: "cron", budgetMs: budget(), minStartMs: AI_QUEUE_MIN_START_MS, maxPerWorker: 2 });
  });

  // A CLIENT'S CHANGE REQUEST NOBODY SPLIT (Oct 16 2026): a brief whose first
  // reading failed or died with its request is read here once it is ten
  // minutes old, up to three tries in all, the failure kept on the row
  // (lib/revisionBriefSweep). Client work, so it goes before the program's
  // sweeps; three at most a run, each started only with time to finish. Not
  // behind `ai_runs`: the first reading of the same words is not either.
  await step("revisionBriefs", async () => {
    const { sweepUnanalyzedBriefs, BRIEF_SWEEP_MIN_START_MS } = await import("@/lib/revisionBriefSweep");
    return sweepUnanalyzedBriefs({ max: 3, budgetMs: budget(), minStartMs: BRIEF_SWEEP_MIN_START_MS });
  });

  const run: Record<AiWorkStep, () => Promise<unknown>> = {
    // Transcript jobs: INGEST + the AI kinds (call analysis, strategy drafts,
    // fact extraction). Behind `transcript_jobs` (a missing row is off).
    transcriptJobs: async () => {
      const { driveTranscriptJobs, TRANSCRIPT_JOBS_PER_TICK, TRANSCRIPT_JOB_MIN_START_MS } = await import("@/lib/transcriptJobs");
      const jobs = await driveTranscriptJobs({ max: TRANSCRIPT_JOBS_PER_TICK, budgetMs: budget(), minStartMs: TRANSCRIPT_JOB_MIN_START_MS, leaseBy: "ai-cron" });
      // THE CALLS' FOLLOW-THROUGH (Oct 27 2026, Jordan: "AI should handle
      // it"), after the calls are read: what a call left is sorted where it
      // is used (knowledgeCurator), a call nobody could place is put to the
      // model (callAutoMatch), a client's portal message is read for a
      // complaint (contentComplaints). Each behind `ai_runs`, each call
      // started only with time to finish; the model down changes nothing.
      const [{ sweepKnowledgeCuration }, { aiMatchWaitingCalls, CALL_MATCH_MIN_START_MS }, { sweepMessageComplaints, COMPLAINT_MIN_START_MS }, { isAutomationEnabled }] = await Promise.all([
        import("@/lib/knowledgeCurator"), import("@/lib/callAutoMatch"), import("@/lib/contentComplaints"), import("@/lib/programAutomation"),
      ]);
      const knowledge = await sweepKnowledgeCuration({ max: 2, budgetMs: budget(), minStartMs: 60_000 });
      const aiOn = await isAutomationEnabled("ai_runs");
      const callMatch = aiOn ? await aiMatchWaitingCalls({ max: 3, budgetMs: budget(), minStartMs: CALL_MATCH_MIN_START_MS }) : { skipped: "ai_runs is off" };
      const complaints = aiOn ? await sweepMessageComplaints({ max: 4, budgetMs: budget(), minStartMs: COMPLAINT_MIN_START_MS }) : { skipped: "ai_runs is off" };
      return { ...(jobs as Record<string, unknown>), knowledge, callMatch, complaints };
    },
    // THE DRAFTING CHAIN (F07/F08, Sep 22 2026): a client's written answers
    // and a reconciled planning call both end in a draft in the review lane.
    // Behind `script_drafting` AND `ai_runs`. Questions first: phrasing them
    // for the topic has to happen BEFORE the client opens them.
    scriptDrafting: async () => {
      const { sweepInterviewPlans, sweepOwedScripts, INTERVIEW_PLAN_MIN_START_MS, SCRIPT_DRAFT_MIN_START_MS } = await import("@/lib/contentDrafting");
      const plans = await sweepInterviewPlans({ max: 4, budgetMs: budget(), minStartMs: INTERVIEW_PLAN_MIN_START_MS });
      const drafts = await sweepOwedScripts({ max: 6, budgetMs: budget(), minStartMs: SCRIPT_DRAFT_MIN_START_MS });
      // Oct 14 2026: the automatic check and fix a draft's own run had no time
      // to finish (scriptJudge.ts). Behind `ai_runs` (unattended), like every
      // model call here; each start is checked against what is left.
      const { sweepScriptChecks, JUDGE_MIN_START_MS } = await import("@/lib/scriptJudge");
      const checks = await sweepScriptChecks({ max: 4, budgetMs: budget(), minStartMs: JUDGE_MIN_START_MS });
      return { plans, drafts, checks };
    },
    // CP-07: the initial bank after a strategy is approved, and per-pillar
    // refills when usable stock runs low. Behind `topic_refresh`; every result
    // is a suggestion Jordan reviews, nothing reaches a client.
    topicBanks: async () => {
      const { sweepTopicBanks } = await import("@/lib/contentTopics");
      const banks = await sweepTopicBanks({ max: TOPIC_REFRESH_MAX, budgetMs: budget(), minStartMs: TOPIC_REFRESH_MIN_START_MS });
      // Oct 14 2026: a creative identity missing or built from an older
      // strategy version is (re)built, a few per run, before the next bank or
      // script reads it. Behind `ai_runs` (unattended).
      const { sweepCreativeIdentities } = await import("@/lib/creativeIdentity");
      const identities = await sweepCreativeIdentities({ max: 3, budgetMs: budget(), minStartMs: 45_000 });
      return { ...banks, identities };
    },
  };
  // EACH APPROVED MONTHLY VIDEO'S TRANSCRIPT, THEN ITS CAPTION (Oct 23 2026).
  // Before the rotation: both are short (Deepgram answers a sub-minute video
  // in seconds; a caption is one small Sonnet call), and a client is waiting
  // on them. Transcripts: behind `cut_transcripts` and a connected provider;
  // a catch-up asks for any approved monthly version with none (never a
  // listing video, never one approved before this began), then the driver
  // transcribes, each call started only with time to finish. Captions: once
  // per approved version, behind `caption_assistant` + the rollout and
  // `ai_runs`, stopped while the AI account is refusing; the same tick's
  // transcripts are already done, so they draft from the spoken words.
  await step("cutTranscripts", async () => {
    const { requestMissingMonthlyTranscripts, runCutTranscriptDriver, CUT_TRANSCRIPT_MIN_START_MS } = await import("@/lib/cutTranscripts");
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    const requests = (await isAutomationEnabled("cut_transcripts")) ? await requestMissingMonthlyTranscripts({ max: 10 }) : { skipped: "cut_transcripts is off" };
    const driver = await runCutTranscriptDriver({ limit: 4, leaseBy: "ai-cron", budgetMs: Math.min(budget(), 120_000), minStartMs: CUT_TRANSCRIPT_MIN_START_MS });
    return { requests, driver };
  });
  await step("captions", async () => {
    const { sweepAutoCaptions, CAPTION_DRAFT_MIN_START_MS } = await import("@/lib/postingKit");
    return sweepAutoCaptions({ max: 3, budgetMs: Math.min(budget(), 150_000), minStartMs: CAPTION_DRAFT_MIN_START_MS });
  });

  // RECURRING COMPLAINT THEMES (Jordan's Loom, Oct 27 2026: "Recurring client
  // complaint: 3 clients in 7 days about bathroom angles"). One fast-model
  // call a run at most, tagging the week's client messages and Slack not read
  // yet (lib/complaintThemes). Behind `ai_runs`; skipped while the AI account
  // refuses or without the time to finish; a failure changes nothing.
  await step("complaintThemes", async () => {
    const { runComplaintThemes, THEMES_MIN_START_MS } = await import("@/lib/complaintThemes");
    return runComplaintThemes({ budgetMs: Math.min(budget(), 70_000), minStartMs: THEMES_MIN_START_MS });
  });

  const order = aiWorkOrder(startedAt);
  out.order = order;
  for (const name of order) await step(name, run[name]);

  await finish();
  return NextResponse.json(out);
}
