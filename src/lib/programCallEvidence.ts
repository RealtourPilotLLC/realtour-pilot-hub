type TranscriptJob = { kind: string; state: string; lastError: string | null; reviewReason: string | null };

/** Read-only wording. Queued/confirmed is evidence held, not completed analysis.
 * No worker, rollout or backlog permission is inferred from a queued job. */
export function programCallEvidence(input: {
  held: boolean;
  call: { transcriptState: string; lastError: string | null } | null;
  manualText: boolean;
  processed: boolean;
  jobs: TranscriptJob[];
  processorEnabled: boolean | null;
}) {
  const { call, manualText, processed } = input;
  const analysed = call?.transcriptState === "ANALYZED";
  // Drafting and fact extraction follow analysis; their failures are separate
  // automation work and must not say that the call transcript disappeared.
  const jobs = input.jobs.filter((job) => job.kind === "INGEST" || job.kind === "ANALYZE");
  const failed = jobs.find((job) => job.state === "FAILED");
  const review = jobs.find((job) => job.state === "NEEDS_REVIEW");
  const running = jobs.find((job) => job.state === "RUNNING");
  const queued = jobs.find((job) => job.state === "QUEUED");
  const processing = failed ? "transcript job failed"
    : review ? "transcript job needs a person"
    : running ? "transcript processing"
    : queued ? `transcript queued${input.processorEnabled === false ? " — processing is off" : input.processorEnabled === null ? " — processor state unavailable" : ""}`
    : jobs.some((job) => job.kind === "ANALYZE" && job.state === "SUCCEEDED") ? "transcript processed"
    : jobs.some((job) => job.kind === "INGEST" && job.state === "SUCCEEDED") ? "transcript imported"
    : jobs.some((job) => job.state === "CANCELLED") ? "transcript jobs cancelled" : null;
  const evidence = analysed ? "transcript analysed"
    : manualText ? "transcript pasted by hand"
    : processed ? "transcript marked processed"
    : call?.transcriptState === "CONFIRMED" ? "transcript held, not analysed yet"
    : call?.transcriptState === "CANDIDATES" ? "possible transcripts found — none confirmed"
    : call?.transcriptState === "FAILED" ? "transcript import failed"
    : call?.transcriptState === "NEEDS_REVIEW" ? "transcript needs a person"
    : call?.transcriptState === "AWAITING" ? "waiting for the transcript"
    : call ? "no transcript" : null;
  const incomplete = input.held && !analysed && !processed && !manualText;
  // Preserve the overview's existing hard/soft priority boundary: explicit
  // call failure/review/identity problems outrank scripts; held/queued work
  // remains a soft preparation note once scripts or later work exist.
  const hardProblem = !incomplete ? null
    : call?.transcriptState === "FAILED" ? `Call was held — the transcript import failed${call.lastError ? ` (${call.lastError.slice(0, 80)})` : ""}`
    : call?.transcriptState === "NEEDS_REVIEW" ? "Call was held — the transcript needs a person before it can be used"
    : call?.transcriptState === "CANDIDATES" ? "Call was held — a transcript was found but nobody confirmed it belongs to this call" : null;
  const pending = incomplete && !hardProblem && (call?.transcriptState === "CONFIRMED" || !!queued || !!running || !!failed || !!review);
  const queueNote = queued?.lastError ? ` Last queue note: ${queued.lastError.slice(0, 160)}.` : "";
  const problem = hardProblem ?? (!incomplete ? null
    : failed ? "Call was held — transcript processing failed; review the failed job"
    : review ? "Call was held — transcript processing needs a person before it can continue"
    : running ? "Call was held — the transcript is being processed"
    : queued ? `Call was held — ${call?.transcriptState === "CONFIRMED" ? "the confirmed transcript is" : "transcript processing is"} queued${input.processorEnabled === false ? "; call processing is off" : input.processorEnabled === null ? "; processor state is unavailable" : ""}.${queueNote} Review the queue's backlog and rollout holds.`
    : call?.transcriptState === "CONFIRMED" ? "Call was held — the transcript is confirmed and awaiting analysis"
    : "Call was held — no transcript or notes came back from it");
  return {
    evidence, processing, hardProblem, problem,
    preparationWord: pending ? `incomplete — ${processing ?? "transcript awaiting analysis"}`
      : hardProblem ? "incomplete — call evidence needs attention" : "incomplete — no call transcript or notes available",
    cta: pending ? "Review transcript processing" : "Fix the transcript",
  };
}
