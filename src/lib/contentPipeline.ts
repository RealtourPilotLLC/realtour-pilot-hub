import "server-only";
import { prisma } from "@/lib/prisma";
import { customerNote } from "@/lib/clientNotes";
import { isAutomationEnabled } from "@/lib/programAutomation";
import { AutomationDisabledError } from "@/lib/aiRuns";
import type { TranscriptJobHandler, TranscriptJobHandlers, TranscriptJobOutcome } from "@/lib/transcriptJobs";

// ---------------------------------------------------------------------------
// The Content Program AI pipeline — the entry points the workspace, the
// cron and the portal have always called. Since Sep 17 2026 every one of
// them runs THROUGH the versioned policy (src/lib/contentPolicy) and the run
// ledger (src/lib/aiRuns.ts) via src/lib/contentGeneration.ts:
//   transcript → PROPOSED selections + bank ideas + PROPOSED facts + proposals
//   selected topics → ContentScriptVersion drafts (three points, 20–30 s)
//   script → a NEW version on revision (an edit is never erased)
//   bank seeding → a ContentTopicRefreshRun with reviewable suggestions
//
// Human-review rule holds throughout: nothing generated is selected,
// approved, accepted or client-visible on its own.
//
// The `opts` argument on each entry point carries who asked. NO opts, or a
// requester of "system"/"cron", means UNATTENDED — the ai_runs switch gates it
// by omission, not by the caller's cooperation (the hourly cron passes nothing
// and must not run the model while every switch is off). A person's click
// passes { requestedBy: <email>, unattended: false } and is allowed.
// ---------------------------------------------------------------------------

export type PipelineOpts = { requestedBy?: string; unattended?: boolean };
const who = (o?: PipelineOpts) => {
  const requestedBy = o?.requestedBy ?? "system";
  const unattended = o?.unattended ?? (requestedBy === "system" || requestedBy === "cron");
  return { requestedBy, unattended };
};
/** Fail BEFORE taking any claim: an unattended run with the switch off must leave no stamp, no counter, no flipped topic behind. */
async function assertAllowed(w: { unattended: boolean }): Promise<void> {
  if (w.unattended && !(await isAutomationEnabled("ai_runs"))) throw new AutomationDisabledError();
}


// ---------------------------------------------------------------------------
// THE CONTENT RULES — injected into every prompt that creates topics, scripts,
// or profile intel. Born from a real failure (Aug 24): the bank recommended
// Ashley "Why I'd Rather Sell Three $350k Houses Than One $1M House" — pulled
// straight from his call, but it undercuts his positioning and price-point
// audience — and his private brokerage plans were fair game for extraction.
// ---------------------------------------------------------------------------
export const CONTENT_RULES =
  "NON-NEGOTIABLE CONTENT RULES:\n" +
  "1. STRATEGIC FIT — every topic/script must actively grow THIS agent's brand with THEIR stated target audience and " +
  "positioning (in the strategy above). An idea the agent mentioned on a call is NOT automatically a good topic: if it " +
  "would undercut their positioning, alienate part of their market, cap their price point, disparage a segment they " +
  "serve, or read as complaining/inside-baseball, DO NOT produce it — no matter who suggested it.\n" +
  "2. THE FOUR OUTCOMES — every topic/script must clearly build at least two of Trust, Credibility, Value, " +
  "Entertainment for the agent's AUDIENCE (home buyers/sellers — not other agents), with Trust and Credibility " +
  "preferred. If you cannot say plainly which outcomes it builds and for whom, it does not qualify.\n" +
  "3. CONFIDENTIALITY — anything the agent frames as private ('between us', 'off the record', 'don't share this yet') " +
  "and categorically: unannounced brokerage moves or exits, internal business plans, recruiting, financial or legal or " +
  "personal disclosures, negative remarks about named people or companies — must NEVER appear in a topic, script, " +
  "hook, or anything a client or the public could see. Such facts may only be recorded as internal profile intel " +
  "prefixed '[CONFIDENTIAL]'.";

// ---------------------------------------------------------------------------
// 1. Transcript extraction → PROPOSALS (spec §5/§23). The old numbers are kept
// on the result so every caller's message still reads; `confirmedTopics` now
// counts PROPOSED selections a person reconciles on the Video Topics tab.
// ---------------------------------------------------------------------------
export type ExtractionResult = {
  confirmedTopics: number; futureIdeas: number; rejected: number; intelNotes: number; todos: number;
  proposals: number; confidentialFacts: number; callKind: string; targetMonthId: string;
  /** Topics the call raised again that a person had already selected (kept) or removed/rejected (withheld) — untouched. */
  keptSelections: number; withheldSelections: number;
};

export async function processMonthTranscript(monthId: string, opts?: PipelineOpts): Promise<ExtractionResult> {
  const month = await prisma.contentMonth.findUnique({
    where: { id: monthId },
    select: { id: true, enrollmentId: true, clientId: true, monthKey: true, transcriptText: true, videosOwed: true, transcriptProcessedAt: true, strategyCallAt: true, callRecordId: true, transcriptSource: true },
  });
  if (!month?.transcriptText) throw new Error("No transcript on this month yet.");
  await assertAllowed(who(opts));
  // ATOMIC CLAIM — the cron and a human's Analyze click can race (Aug 24: two
  // concurrent extractions gave John Collins 6 topics and duplicate scripts).
  // Whoever flips transcriptProcessedAt from null wins; everyone else bows out.
  const claim = await prisma.contentMonth.updateMany({
    where: { id: monthId, transcriptProcessedAt: null },
    data: { transcriptProcessedAt: new Date() },
  });
  if (claim.count === 0 && !month.transcriptProcessedAt) throw new Error("This transcript is already being analyzed.");
  if (claim.count === 0) throw new Error("This transcript was already analyzed.");

  // From here on the claim is OURS — an AI hiccup must RELEASE it, or the month
  // is permanently marked "analyzed" over zero topics with no way to retry
  // (audit Aug 25: the card said "topics and scripts are below" over nothing).
  try {
    const { analyzeTranscriptText } = await import("@/lib/contentGeneration");
    const r = await analyzeTranscriptText({
      enrollmentId: month.enrollmentId, clientId: month.clientId, monthId, monthKey: month.monthKey, transcript: month.transcriptText,
      callDate: month.strategyCallAt, videosOwed: month.videosOwed, callRecordId: month.callRecordId, ...who(opts),
    });
    return { confirmedTopics: r.proposedSelections, keptSelections: r.keptSelections, withheldSelections: r.withheldSelections, futureIdeas: r.discussed, rejected: r.rejected, intelNotes: r.facts, todos: r.todos, proposals: r.proposals, confidentialFacts: r.confidentialFacts, callKind: r.callKind, targetMonthId: r.targetMonthId };
  } catch (e) {
    // Release the claim so the month can be analyzed again — a stamped-but-
    // empty month was unrecoverable from the UI (audit Aug 25). CAPPED at
    // three failures: after that the stamp STAYS so a deterministically
    // failing transcript can't become an hourly AI retry loop (review
    // finding); the Re-analyze button still force-clears for a human retry.
    try {
      const key = `transcript-fails-${monthId}`;
      const row = await prisma.appSetting.findUnique({ where: { key } });
      const fails = Number(row?.value ?? 0) + 1;
      await prisma.appSetting.upsert({ where: { key }, create: { key, value: String(fails) }, update: { value: String(fails) } });
      if (fails < 3) {
        await prisma.contentMonth.updateMany({ where: { id: monthId }, data: { transcriptProcessedAt: null } });
      }
    } catch { /* releasing is best-effort */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 2. Script generation — one ContentScriptVersion per SELECTED topic that has
// none yet, through the policy prompt (hook, exactly three roled points,
// close, 20–30 s) and the validator. INTERNAL_REVIEW. Call-PROPOSED
// selections are skipped until a person reconciles them.
// ---------------------------------------------------------------------------
export async function generateScriptsForMonth(monthId: string, opts?: PipelineOpts): Promise<{ generated: number; skipped: number }> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, callRecordId: true } });
  if (!month) throw new Error("Month not found.");
  const topics = await prisma.contentTopic.findMany({ where: { monthId, status: "SELECTED" }, select: { id: true } });
  if (!topics.length) return { generated: 0, skipped: 0 };
  await assertAllowed(who(opts));
  const scripted = new Set((await prisma.contentScript.findMany({ where: { monthId, topicId: { not: null }, historical: false }, select: { topicId: true } })).map((s) => s.topicId));
  const { generateScriptForTopic } = await import("@/lib/contentGeneration");
  let generated = 0, skipped = 0;
  for (const t of topics) {
    if (scripted.has(t.id)) { skipped++; continue; }
    // Claim the topic atomically — a concurrent generator sees count 0 and
    // skips, so a topic can never get two scripts.
    const claim = await prisma.contentTopic.updateMany({ where: { id: t.id, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    if (claim.count === 0) { skipped++; continue; }
    try {
      await generateScriptForTopic({ topicId: t.id, monthId, callRecordId: month.callRecordId, ...who(opts) });
      generated++;
    } catch {
      // Give the topic back so a retry can script it.
      await prisma.contentTopic.update({ where: { id: t.id }, data: { status: "SELECTED" } }).catch(() => {});
      skipped++;
    }
  }
  return { generated, skipped };
}

// ---------------------------------------------------------------------------
// 3. AI revision — a NEW version following the reviewer's instruction. The
// version being revised (and any hand edit in it) stays exactly as it was.
// ---------------------------------------------------------------------------
export async function reviseScriptWithInstructions(scriptId: string, instructions: string, opts?: PipelineOpts & { source?: "REVISION" | "CLIENT_REQUEST" }): Promise<void> {
  const { reviseScript } = await import("@/lib/contentGeneration");
  await reviseScript(scriptId, instructions, who(opts).requestedBy, opts?.source ?? "REVISION");
}

// ---------------------------------------------------------------------------
// 4. Topic bank seeding (spec §18/§27) — a ContentTopicRefreshRun whose
// suggestions Jordan accepts one by one; N per pillar from the policy
// (10, configurable to 15), archived concepts never resurface, and duplicate
// clicks join the running job. `created` = suggestions awaiting his review.
// ---------------------------------------------------------------------------
export async function seedTopicBank(enrollmentId: string, perPillar?: number | null, opts?: PipelineOpts): Promise<{ created: number; pillars: string[]; runId: string; needsInput: string[] }> {
  const { startTopicRefresh } = await import("@/lib/contentTopics");
  const { listPillars } = await import("@/lib/contentPillars");
  const existing = await prisma.contentTopic.count({ where: { enrollmentId, status: { notIn: ["REJECTED", "ARCHIVED"] } } });
  const { runId } = await startTopicRefresh({ enrollmentId, kind: existing > 0 ? "REFRESH" : "BANK", topicsPerPillar: perPillar ?? null, ...who(opts) });
  const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: runId }, select: { generatedCount: true, missingContextJson: true, status: true } });
  let needsInput: string[] = [];
  try { const mc = run?.missingContextJson ? (JSON.parse(run.missingContextJson) as { missing?: string[]; gaps?: string[] }) : null; needsInput = [...(mc?.missing ?? []), ...(mc?.gaps ?? [])]; } catch { /* none */ }
  return { created: run?.generatedCount ?? 0, pillars: (await listPillars(enrollmentId)).map((p) => p.name), runId, needsInput };
}

// ---------------------------------------------------------------------------
// 4b. Transcript-job handlers for W1-B's driver (src/lib/transcriptJobs.ts).
// The driver leases the job, checks the transcript_jobs switch and records the
// outcome; each handler here delegates to contentGeneration.runTranscriptJob,
// which reads CONFIRMED ProgramTranscriptSource rows by callRecordId (never
// ContentMonth.transcriptText), never touches the job row, and runs its AI
// unattended behind ai_runs. Outcome mapping: resultJson → produced;
// reviewReason → needsReview; error → error, retryable only for transport /
// rate-limit failures (everything else goes to a person, not a retry loop).
// ---------------------------------------------------------------------------
const RETRYABLE_RE = /\b(429|503|529|rate.?limit|overloaded|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|network)\b/i;

function transcriptHandler(kind: "ANALYZE" | "STRATEGY_DRAFT" | "SCRIPT_DRAFT" | "FACT_EXTRACT"): TranscriptJobHandler {
  return async (job, ctx): Promise<TranscriptJobOutcome> => {
    const { runTranscriptJob } = await import("@/lib/contentGeneration");
    const r = await runTranscriptJob({ id: job.id, kind, callRecordId: job.callRecordId, transcriptSourceId: job.transcriptSourceId, enrollmentId: job.enrollmentId, requestedBy: job.requestedBy, heartbeat: ctx.heartbeat });
    if (r.ok) return { ok: true, produced: r.resultJson, aiRunId: r.aiRunId ?? null };
    if (r.reviewReason) return { ok: false, needsReview: r.reviewReason };
    const error = r.error ?? "unknown failure";
    return { ok: false, error, retryable: RETRYABLE_RE.test(error) };
  };
}

export const transcriptJobHandlers: TranscriptJobHandlers = {
  ANALYZE: transcriptHandler("ANALYZE"),
  STRATEGY_DRAFT: transcriptHandler("STRATEGY_DRAFT"),
  SCRIPT_DRAFT: transcriptHandler("SCRIPT_DRAFT"),
  FACT_EXTRACT: transcriptHandler("FACT_EXTRACT"),
};

// ---------------------------------------------------------------------------
// 5. Agent profile builder (spec §6) — synthesized from strategy calls,
// discovery calls (their distilled intel notes), the content strategy, and the
// scripts actually FILMED (the truest record of their voice). Non-destructive:
// existing keys in a section are kept; only NEW keys are added, so a hand-
// written note is never overwritten by AI.
// ---------------------------------------------------------------------------
const PROFILE_BUILD_SECTIONS: { key: "brandJson" | "voiceJson" | "contentPrefsJson" | "productionJson" | "editingJson" | "storiesJson"; label: string; guide: string }[] = [
  { key: "brandJson", label: "Brand & positioning", guide: "Positioning, primary message, target audience, markets, specialties, differentiators, content pillars, goals" },
  { key: "voiceJson", label: "Voice & scripting style", guide: "Tone, cadence, humor, phrases they actually use (from their filmed scripts), phrases to avoid, script format preference, CTA style" },
  { key: "contentPrefsJson", label: "Content preferences", guide: "Topics they love / avoid, formats, storytelling comfort, polarization comfort, personal-life comfort" },
  { key: "productionJson", label: "Production", guide: "Locations, preferred days/times, teleprompter, wardrobe, on-camera notes" },
  { key: "editingJson", label: "Editing style", guide: "Pacing, captions, music, graphics, recurring revision patterns" },
  { key: "storiesJson", label: "Stories, POVs & knowledge", guide: "Real stories, strong opinions, expertise areas, local knowledge — each entry concrete and attributable" },
];

export async function buildAgentProfileFromHistory(clientId: string, opts?: PipelineOpts): Promise<{ sectionsFilled: number; keysAdded: number }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { clientId }, select: { id: true } });
  if (!e) throw new Error("No enrollment for this client.");
  const { factsForPrompt, factLines } = await import("@/lib/clientFacts");
  const [client, strategy, facts, scripts] = await Promise.all([
    // generalNotes is THE customer note; editingPreferences is the retired
    // column, still read as a fallback (src/lib/clientNotes.ts).
    prisma.client.findUnique({
      where: { id: clientId },
      select: { name: true, company: true, generalNotes: true, editingPreferences: true },
    }),
    prisma.contentStrategy.findFirst({ where: { enrollmentId: e.id, status: "ACTIVE" }, select: { sectionsJson: true } }),
    // ACCEPTED, AI-allowed, non-confidential facts only (spec §23). The old
    // read of the raw intel pile is how Ashley Brunner's unannounced
    // brokerage move reached the script writer, through storiesJson.
    factsForPrompt(clientId, { take: 60 }),
    prisma.contentScript.findMany({ where: { clientId, source: "import" }, orderBy: { createdAt: "desc" }, take: 8, select: { title: true, body: true } }),
  ]);

  const intelNotes = factLines(facts).map((body) => ({ body }));
  const material: string[] = [];
  material.push(`AGENT: ${client?.name}${client?.company ? ` (${client.company})` : ""}`);
  if (strategy?.sectionsJson) {
    try {
      const sec = JSON.parse(strategy.sectionsJson) as Record<string, string>;
      material.push("CONTENT STRATEGY:\n" + Object.entries(sec).map(([k, v]) => `## ${k}\n${v}`).join("\n"));
    } catch { /* skip */ }
  }
  if (intelNotes.length) material.push("FACTS LEARNED ON STRATEGY & DISCOVERY CALLS:\n" + intelNotes.map((n) => `- ${n.body}`).join("\n"));
  if (scripts.length) material.push("SCRIPTS THEY ACTUALLY FILMED (their real voice):\n" + scripts.map((s) => `### ${s.title}\n${s.body.slice(0, 1200)}`).join("\n\n"));
  // The customer note on file. It read editingPreferences, which has had no
  // writer since the notes cards merged (NULL on all 349 clients), so this
  // evidence line never made it into the profile build.
  const noteOnFile = customerNote(client);
  if (noteOnFile) material.push("CUSTOMER NOTES ON FILE:\n" + noteOnFile);
  if (material.length < 2) return { sectionsFilled: 0, keysAdded: 0 };

  const { runAiJson, activePolicyVersion } = await import("@/lib/aiRuns");
  const policy = await activePolicyVersion();
  const { output: out } = await runAiJson<{ sections: Record<string, Record<string, string>> }>({
    kind: "profile_draft", enrollmentId: e.id, clientId, promptKey: "profile-draft", policyVersionId: policy.id, inputRefs: { factIds: facts.map((f) => f.id), scripts: scripts.length }, ...who(opts),
    system:
      "You are building a real-estate agent's internal working profile for a content-production team, ONLY from the evidence below. " +
      "Fill these sections (JSON object per section, short labeled entries — a few sentences each):\n" +
      PROFILE_BUILD_SECTIONS.map((s) => `- ${s.key}: ${s.label} — ${s.guide}`).join("\n") +
      "\nRULES: never invent — every entry must trace to the material; quote their own phrases where possible (especially voice); " +
      "omit any section or field the evidence doesn't support. This is internal — candid, useful, specific. " +
      "Anything told in confidence or commercially sensitive (unannounced brokerage moves, internal plans, personal/financial disclosures) " +
      "must be prefixed '[CONFIDENTIAL] ' so it can never be used in content.",
    prompt: material.join("\n\n").slice(0, 90_000),
    maxTokens: 16_000,
    schema: {
      type: "object",
      properties: {
        sections: {
          type: "object",
          properties: Object.fromEntries(PROFILE_BUILD_SECTIONS.map((s) => [s.key, { type: "object", additionalProperties: { type: "string" } }])),
        },
      },
      required: ["sections"],
    },
  });

  // The whole sections object can arrive JSON-stringified too (Erica, Aug 24 —
  // the biggest-evidence client hit it). Coerce at both levels.
  let raw: Record<string, unknown> = {};
  if (out.sections && typeof out.sections === "object") raw = out.sections;
  else if (typeof out.sections === "string") { try { const p = JSON.parse(out.sections); if (p && typeof p === "object") raw = p; } catch { raw = {}; } }
  const profile = await prisma.agentProfile.findUnique({ where: { clientId } });
  let sectionsFilled = 0, keysAdded = 0;
  const data: Record<string, string> = {};
  for (const s of PROFILE_BUILD_SECTIONS) {
    let incoming = raw[s.key];
    if (typeof incoming === "string") { try { incoming = JSON.parse(incoming); } catch { incoming = undefined as never; } }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) continue;
    let existing: Record<string, string> = {};
    try { existing = profile?.[s.key] ? JSON.parse(profile[s.key]!) : {}; } catch { existing = {}; }
    let added = 0;
    for (const [k, v] of Object.entries(incoming)) {
      const key = k.trim().slice(0, 80);
      const val = typeof v === "string" ? v.trim().slice(0, 4000) : "";
      if (!key || !val || val.length < 3) continue;
      if (existing[key]) continue; // hand-written (or earlier) entries win
      existing[key] = val;
      added++;
    }
    if (added > 0) { data[s.key] = JSON.stringify(existing); sectionsFilled++; keysAdded += added; }
  }
  if (Object.keys(data).length) {
    await prisma.agentProfile.upsert({ where: { clientId }, create: { clientId, ...data }, update: data });
  }
  return { sectionsFilled, keysAdded };
}
