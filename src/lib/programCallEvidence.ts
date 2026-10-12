import { etMonthDay } from "@/lib/datetime";

type TranscriptJob = { kind: string; state: string; lastError: string | null; reviewReason: string | null };

/**
 * Where a call's confirmed transcript came from, in one plain phrase (Oct 12
 * 2026): "Transcript in from Drive (Gemini notes, Oct 6)". Pure — the month's
 * call card, the Overview's next step, the Strategy calls desk and Settings all
 * say it the same way.
 */
export function transcriptSourceWords(source: { provider: string; recordedAt: Date | string | null } | null | undefined, fallbackAt?: Date | string | null): string {
  const day = etMonthDay(source?.recordedAt ?? fallbackAt ?? null);
  const on = day ? `, ${day}` : "";
  switch (source?.provider) {
    case "drive": return `Transcript in from Drive (Gemini notes${on})`;
    case "meet": return `Transcript in from Google Meet${day ? ` (${day})` : ""}`;
    case "notetaker": return `Transcript in from the notetaker${day ? ` (${day})` : ""}`;
    case "paste": return `Transcript pasted in${day ? ` (${day})` : ""}`;
    case "upload":
    case "pdf": return `Transcript uploaded${day ? ` (${day})` : ""}`;
    default: return `Transcript in${day ? ` (${day})` : ""}`;
  }
}

/** Read-only wording. Queued/confirmed is evidence held, not completed analysis.
 * No worker, rollout or backlog permission is inferred from a queued job. */
export function programCallEvidence(input: {
  held: boolean;
  call: { transcriptState: string; lastError: string | null } | null;
  manualText: boolean;
  processed: boolean;
  jobs: TranscriptJob[];
  processorEnabled: boolean | null;
  /** The confirmed transcript's source, for the plain "Transcript in from Drive (…)" words. */
  source?: { provider: string; recordedAt: Date | string | null } | null;
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
  // A CONFIRMED transcript that is not being processed right now can be
  // analysed by a person on the month's call card (Oct 12 2026) — the step
  // says so and links there, instead of pointing at the queue's holds.
  const analyzeHere = pending && call?.transcriptState === "CONFIRMED" && !running;
  const queueNote = queued?.lastError ? ` Last queue note: ${queued.lastError.slice(0, 160)}.` : "";
  const inWords = transcriptSourceWords(input.source ?? null);
  const why = failed ? "; transcript processing failed"
    : review ? "; transcript processing needs a person"
    : queued ? `; queued${input.processorEnabled === false ? " — automatic analysis is off" : input.processorEnabled === null ? " — processor state unavailable" : ""}`
    : "";
  const problem = hardProblem ?? (!incomplete ? null
    : analyzeHere ? `${inWords} — not analyzed yet${why}.${queueNote} Analyze the call to do it now.`
    : failed ? "Call was held — transcript processing failed; review the failed job"
    : review ? "Call was held — transcript processing needs a person before it can continue"
    : running ? "Call was held — the transcript is being processed"
    : queued ? `Call was held — transcript processing is queued${input.processorEnabled === false ? "; call processing is off" : input.processorEnabled === null ? "; processor state is unavailable" : ""}.${queueNote}`
    : "Call was held — no transcript or notes came back from it");
  return {
    evidence, processing, hardProblem, problem, analyzeHere,
    preparationWord: pending ? `incomplete — ${processing ?? "transcript awaiting analysis"}`
      : hardProblem ? "incomplete — call evidence needs attention" : "incomplete — no call transcript or notes available",
    cta: analyzeHere ? "Analyze the call" : pending ? "Review transcript processing" : "Fix the transcript",
  };
}
