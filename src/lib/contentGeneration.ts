import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { runAiJson, activePolicyVersion, setRunOutputRef, releaseRunKey, sha256, type AiRunKind } from "@/lib/aiRuns";
import { approvedStrategy, createStrategyVersion, setMonthPriorities, monthPriorities, structuredFromText, parseStoredSections, deriveStrategyVersion } from "@/lib/contentStrategy";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { createTopic, selectTopicForMonth, recordTopicEvent, blockedTopicHashes, pendingSuggestionHashes, finishRefreshRun, topicDedupeHash, type Actor } from "@/lib/contentTopics";
import { assembleInterviewInputs } from "@/lib/contentInterview";
import { createScriptVersion, ensureScriptVersioned, pointsFromJson, pillarNameOf, type VersionParts } from "@/lib/contentScripts";
import { factsForPrompt, factLines, confidentialFilter, CONFIDENTIAL_RE, CONFIDENTIAL_PHRASE_RE, type FactCategory } from "@/lib/clientFacts";
import { CONTENT_RULES } from "@/lib/contentPipeline";
import {
  buildScriptPrompt, buildTopicBankPrompt, buildStrategyPrompt, buildStrategyRevisionPrompt, scriptFromGeneratorOutput, validateNewScript, validateTopicBank, renderStrategy, policyFrameworkSection,
  GENERATION_POLICY, GENERATION_POLICY_VERSION, SPEAKER_ATTRIBUTION_RULE, NO_INVENTION_RULE, makeTopic, normalizeTitle, policyStamp,
  type ClientContext, type SourceExcerpt, type GeneratedScriptJson, type Topic, type TopicBank, type Gap, type StrategyDocument,
} from "@/lib/contentPolicy";

// ---------------------------------------------------------------------------
// GENERATION — the only place the Content Program talks to the model, and it
// does so through the POLICY (src/lib/contentPolicy): prompts come from
// buildScriptPrompt / buildTopicBankPrompt / buildStrategyPrompt, every output
// passes the deterministic validators, every call is a ProgramAiRun with its
// policy + strategy version, and every result lands as a VERSION or a
// SUGGESTION for a human — never as approved, selected, filmed or released.
//
// Client scoping: buildClientContext() reads ONE enrollment's approved
// strategy, accepted facts and own prior scripts. Lines naming another
// enrolled client are stripped before they reach a prompt (the portal-prefill
// leak, Sep 3, must never repeat in a script) and the prompt builder's
// assertClientScoped refuses mixed inputs on top of that.
// ---------------------------------------------------------------------------

// --- client context ---------------------------------------------------------------

/** The names a client's lines are scrubbed of: every OTHER enrolled client's full name and its first two words. */
function namesToScrub(clients: { name: string | null }[]): string[] {
  const out: string[] = [];
  for (const c of clients) {
    const n = (c.name ?? "").trim();
    const w = n.split(/\s+/);
    if (w.length >= 2) out.push(n, `${w[0]} ${w[1]}`);
  }
  return [...new Set(out.filter((n) => n.length >= 5))];
}

async function otherClientNames(clientId: string): Promise<string[]> {
  const enrolled = await prisma.contentEnrollment.findMany({ where: { clientId: { not: clientId } }, select: { clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: enrolled.map((e) => e.clientId) } }, select: { name: true } });
  return namesToScrub(clients);
}

const scrubWith = (names: string[], lines: string[]): { kept: string[]; stripped: number } => {
  if (!names.length) return { kept: lines, stripped: 0 };
  const re = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const kept = lines.filter((l) => !re.test(l));
  return { kept, stripped: lines.length - kept.length };
};

/** Drop every line that names another enrolled client. Deterministic; logged on the run's inputRefs. */
export async function scrubOtherClients(clientId: string, lines: string[]): Promise<{ kept: string[]; stripped: number }> {
  return scrubWith(await otherClientNames(clientId), lines);
}

/**
 * scrubOtherClients for several clients at once — the same names, the same
 * rule, two queries however many clients (R01, Sep 25 2026: the planning
 * reader scrubs a whole roster's call lines and must not cost a query pair
 * per client).
 */
export async function otherClientScrubbers(clientIds: string[]): Promise<Map<string, (lines: string[]) => string[]>> {
  const out = new Map<string, (lines: string[]) => string[]>();
  if (!clientIds.length) return out;
  const enrolled = await prisma.contentEnrollment.findMany({ select: { clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(enrolled.map((e) => e.clientId))] } }, select: { id: true, name: true } });
  for (const id of new Set(clientIds)) {
    const names = namesToScrub(clients.filter((c) => c.id !== id));
    out.set(id, (lines) => scrubWith(names, lines).kept);
  }
  return out;
}

/**
 * A RAW CALL on its way into a CLIENT-FACING generator (A09, Sep 25 2026).
 * The strategy drafter handed the model the whole discovery transcript — up
 * to 120k characters, unfiltered — and the strategy is released to the
 * client. Line by line, this drops:
 *   · a line carrying a [CONFIDENTIAL] marker anywhere in it;
 *   · a line that SAYS it is private ("between you and me", "off the
 *     record", "don't share this", "hasn't been announced");
 *   · a line overlapping a fact of this client marked confidential (the call's
 *     own analysis marks them — which is why the strategy job waits for it);
 *   · a line naming another enrolled client.
 * Single-word lines ("Right.", "Okay.") are never judged by overlap: a word
 * shared with a secret is not the secret. The counts go on the run's
 * inputRefs, so what was held back is on the record without its content.
 */
export async function scrubTranscriptForGeneration(clientId: string, text: string): Promise<{ text: string; stripped: number; reasons: { marker: number; phrase: number; confidentialFact: number; otherClient: number } }> {
  const overlapsSecret = await confidentialFilter(clientId, { phrases: false });
  const reasons = { marker: 0, phrase: 0, confidentialFact: 0, otherClient: 0 };
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) { kept.push(line); continue; }
    if (CONFIDENTIAL_RE.test(t)) { reasons.marker++; continue; }
    if (CONFIDENTIAL_PHRASE_RE.test(t)) { reasons.phrase++; continue; }
    if (t.split(/\s+/).length >= 2 && overlapsSecret(t)) { reasons.confidentialFact++; continue; }
    kept.push(line);
  }
  const others = await scrubOtherClients(clientId, kept);
  // scrubOtherClients also "strips" blank lines only if they name someone — they never do.
  reasons.otherClient = others.stripped;
  const stripped = reasons.marker + reasons.phrase + reasons.confidentialFact + reasons.otherClient;
  return { text: others.kept.join("\n").replace(/\n{3,}/g, "\n\n"), stripped, reasons };
}

export type BuiltContext = { ctx: ClientContext; enrollmentId: string; clientId: string; strategyVersionId: string | null; strategyLabel: string | null; policyVersionId: string; inputRefs: Record<string, unknown> };

export async function buildClientContext(enrollmentId: string, opts: { monthId?: string | null; monthKey?: string | null; projectId?: string | null; priorScripts?: number } = {}): Promise<BuiltContext> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const [client, strategy, policy, facts, prior] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    approvedStrategy(enrollmentId),
    activePolicyVersion(),
    factsForPrompt(e.clientId, { monthId: opts.monthId ?? null, projectId: opts.projectId ?? null }),
    prisma.contentScript.findMany({ where: { enrollmentId, source: "import" }, orderBy: { createdAt: "desc" }, take: opts.priorScripts ?? 3, select: { id: true, title: true, body: true, monthId: true } }),
  ]);
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const explicit = factLines(facts.filter((f) => f.category === "BRAND_PREFERENCE" || f.category === "PRODUCTION_PREFERENCE" || f.category === "DECISION"));
  const known = factLines(facts.filter((f) => !["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "DECISION", "INTERNAL"].includes(f.category)));
  const [expl, kn] = await Promise.all([scrubOtherClients(e.clientId, explicit), scrubOtherClients(e.clientId, known)]);
  const priorScripts: ClientContext["priorScripts"] = [];
  let strippedScripts = 0;
  for (const s of prior) {
    // A prior script that names another client (a referral story) is dropped whole.
    const r = await scrubOtherClients(e.clientId, [s.body]);
    if (r.stripped) { strippedScripts++; continue; }
    if (CONFIDENTIAL_RE.test(s.body)) { strippedScripts++; continue; }
    priorScripts.push({ title: s.title, text: s.body.slice(0, 2500), monthKey: s.monthId ? monthKeys.get(s.monthId) ?? null : null });
  }
  const ctx: ClientContext = {
    clientId: e.clientId, clientName: client?.name ?? "Client",
    strategy: strategy ? { version: strategy.label, document: strategy.document } : null,
    preferences: { explicit: expl.kept, inferred: [] },
    knownFacts: kn.kept,
    priorScripts,
    monthKey: opts.monthKey ?? (opts.monthId ? monthKeys.get(opts.monthId) ?? null : null),
  };
  return {
    ctx, enrollmentId, clientId: e.clientId, strategyVersionId: strategy?.versionId ?? null, strategyLabel: strategy?.label ?? null, policyVersionId: policy.id,
    inputRefs: { strategyVersionId: strategy?.versionId ?? null, factIds: facts.map((f) => f.id), priorScriptIds: prior.map((p) => p.id), strippedLines: expl.stripped + kn.stripped + strippedScripts, policyHash: policyStamp(null).policyHash },
  };
}

// --- scripts ----------------------------------------------------------------------

function partsFromGenerated(json: GeneratedScriptJson, pillarId: string | null, clientId: string | null = null): { parts: VersionParts; validation: ReturnType<typeof validateNewScript>; gaps: Gap[] } {
  const script = scriptFromGeneratorOutput(json, policyStamp(null), clientId);
  const validation = validateNewScript(script);
  const parts: VersionParts = {
    title: script.title, categoryLabel: script.pillarRef?.categoryAsDelivered ?? json.category ?? null, pillarId,
    hook: script.hook?.text ?? "", points: script.points.map((p) => ({ role: p.role, text: p.text })), close: script.close?.text ?? "", captionCta: script.captionCta,
    filmingNotes: script.internal.filmingNotes, sourceExcerpts: script.internal.sourceExcerpts, dimensionsCheck: (script.internal.contentPillarCheck as Record<string, string> | null) ?? null, placeholders: script.internal.placeholders,
  };
  return { parts, validation, gaps: validation.gaps };
}

async function policyTopic(topicId: string): Promise<{ topic: Topic; row: NonNullable<Awaited<ReturnType<typeof prisma.contentTopic.findUnique>>> }> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId } });
  if (!t) throw new Error("Topic not found.");
  // U01: never an invented "(no pillar)" name — it came back as the script's category.
  const pillarName = (await pillarNameOf(t.pillarId, t.enrollmentId)) ?? t.pillar ?? "";
  return {
    row: t,
    topic: { id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: t.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: null, stamp: null },
  };
}

/**
 * Speaker-tagged excerpts recorded for a topic (from call analysis), newest
 * selection first. CP-08: read from ONE place (contentTopics.topicCallExcerpts,
 * which the interview also uses) and scrubbed for confidentiality on the way —
 * the old reader applied no confidential filter at all, so a line the client
 * said in confidence on a call could reach a script prompt.
 */
async function excerptsForTopic(topicId: string, monthId: string | null): Promise<SourceExcerpt[]> {
  const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { clientId: true } });
  if (!t) return [];
  const { safeTopicExcerpts } = await import("@/lib/contentTopics");
  const { kept } = await safeTopicExcerpts(topicId, monthId, t.clientId);
  return kept.map((e): SourceExcerpt => ({ speaker: e.speaker, speakerName: e.speakerName, source: e.source, text: e.text }));
}

/** CP-08: the script prompt with the per-part word budgets — every script draft names it, so a before/after on estimated length is attributable. */
const SCRIPT_PROMPT_VERSION = "script.v2-budgets";

export type GenerateScriptOpts = {
  topicId: string; monthId: string | null; requestedBy: string; unattended: boolean; callRecordId?: string | null; excerpts?: SourceExcerpt[]; selectedOnCall?: boolean;
  /** The "draft what's owed" sweep: never add a version to a script that exists — see AlreadyDraftedError. */
  onlyIfUnscripted?: boolean;
};

// ---------------------------------------------------------------------------
// THE OWED-SCRIPT SWEEP DRAFTS A TOPIC ONCE (Sep 24). draftOwedScriptsForMonth
// reads its work list once, then spends 20-60 s per model call walking it. Two
// sweeps (the hourly one and Kyle's "Draft what's owed", or two presses) that
// overlap could each draft the same topic: the other run finished it start to
// finish while this one was still in the model on an earlier topic, released
// the dedupe key, and this one reached it with its stale list — a second paid
// run and a version 2 nobody asked for. So the sweep path (onlyIfUnscripted):
//   · re-checks for this month's script right before it claims, and
//   · holds the dedupe key until the version is written (holdDedupeKey), so a
//     run that passed the re-check while the other was between "model
//     returned" and "version written" still collides on the key, and
//   · refuses at write time if a script appeared anyway by a path that takes
//     no key (a script typed or imported by hand) — the paid output is kept
//     on the run row, never added as a version.
// A person asking for a NEW draft of one topic still gets one: that path does
// not set onlyIfUnscripted.
// ---------------------------------------------------------------------------
export class AlreadyDraftedError extends Error {
  constructor(what: string) { super(`Already drafted — ${what} got its script from another run after this sweep read its list.`); this.name = "AlreadyDraftedError"; }
}
async function assertUnscripted(topicId: string, monthId: string | null, interviewId: string | null, what: string): Promise<void> {
  const existing = await prisma.contentScript.findFirst({
    where: { historical: false, OR: [{ topicId, monthId }, ...(interviewId ? [{ interviewId }] : [])] },
    select: { id: true },
  });
  if (existing) throw new AlreadyDraftedError(what);
}

/** Transcript / topic path: one script version (INTERNAL_REVIEW) for a topic, through the policy prompt + validator. */
export async function generateScriptForTopic(o: GenerateScriptOpts): Promise<{ scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number }> {
  const { topic, row } = await policyTopic(o.topicId);
  const built = await buildClientContext(row.enrollmentId, { monthId: o.monthId });
  const excerpts = o.excerpts ?? (await excerptsForTopic(o.topicId, o.monthId));
  const scrub = await scrubOtherClients(row.clientId, excerpts.map((e) => e.text));
  const bundle = buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: excerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: o.selectedOnCall ?? true });
  if (o.onlyIfUnscripted) await assertUnscripted(o.topicId, o.monthId, null, `"${row.title}"`);
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: row.enrollmentId, clientId: row.clientId, scope: { topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, excerpts: excerpts.length },
    promptKey: "script", promptVersion: SCRIPT_PROMPT_VERSION, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: `script:${o.topicId}:${o.monthId ?? "bank"}`, holdDedupeKey: true, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000,
  });
  try {
    const { parts, validation, gaps } = partsFromGenerated(run.output, row.pillarId ?? (await resolvePillarByLabel(row.enrollmentId, run.output.category)), row.clientId);
    if (!parts.title) parts.title = row.title;
    // monthId null = the bank-level script (IS NULL), never "any month's script".
    const existing = await prisma.contentScript.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, historical: false }, select: { id: true } });
    if (existing && o.onlyIfUnscripted) throw new AlreadyDraftedError(`"${row.title}"`);
    const r = await createScriptVersion({
      scriptId: existing?.id ?? null, enrollmentId: row.enrollmentId, monthId: o.monthId, topicId: o.topicId, parts, source: "AI", createdBy: o.requestedBy, status: "INTERNAL_REVIEW",
      callRecordId: o.callRecordId ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId, validation: { ok: validation.ok, findings: validation.findings }, gaps,
      changeSummary: `Drafted from the ${excerpts.length ? "call excerpts" : "topic"} (${validation.ok ? "passes the format check" : `${validation.findings.filter((f) => f.severity === "block").length} blocking finding(s)`}; ${gaps.length} gap(s))`,
    });
    await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
    await releaseRunKey(run.runId);
    await prisma.contentTopic.updateMany({ where: { id: o.topicId, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    await recordTopicEvent(o.topicId, row.enrollmentId, "SCRIPTED", { kind: "AI" }, { monthId: o.monthId, sourceRef: `ContentScriptVersion:${r.versionId}` });
    return { scriptId: r.scriptId, versionId: r.versionId, versionNo: r.versionNo, ok: validation.ok, findings: validation.findings.length, gaps: gaps.length };
  } finally {
    await releaseRunKey(run.runId); // idempotent; frees the key if the write above threw
  }
}

/** Written-answer path: a DRAFT version from the interview's exact answer rows, gaps carried through, never filled. */
export async function generateScriptFromInterview(interviewId: string, requestedBy: string, opts: { unattended?: boolean; onlyIfUnscripted?: boolean } = {}): Promise<{ scriptId: string; versionId: string; ok: boolean; gaps: number }> {
  const a = await assembleInterviewInputs(interviewId);
  const built = await buildClientContext(a.enrollmentId, { monthId: a.monthId });
  // The call's own words about this topic ride along beside the answers
  // (CP-08) — already confidential- and other-client-scrubbed.
  const bundle = buildScriptPrompt(built.ctx, { path: "written-answers", input: a.input, excerpts: a.excerpts });
  // The sweep path (see AlreadyDraftedError): a script for this topic in this
  // month, or for these answers, means somebody drafted it while we queued.
  if (opts.onlyIfUnscripted) await assertUnscripted(a.topic.id!, a.monthId, interviewId, `"${a.topic.title}"`);
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: a.enrollmentId, clientId: a.clientId, scope: { interviewId, topicId: a.topic.id, monthId: a.monthId }, inputRefs: { ...built.inputRefs, answerIds: a.answerIds, excerpts: a.excerpts.length },
    promptKey: "script", promptVersion: SCRIPT_PROMPT_VERSION, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: opts.unattended ?? false, dedupeKey: `script:interview:${interviewId}`, holdDedupeKey: true,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000,
  });
  try {
    const { parts, validation, gaps } = partsFromGenerated(run.output, a.topic.pillarRef.pillarId, a.clientId);
    if (!parts.title) parts.title = a.topic.title;
    const existing = await prisma.contentScript.findFirst({ where: { interviewId }, select: { id: true, currentVersionId: true } });
    if (existing && opts.onlyIfUnscripted) throw new AlreadyDraftedError(`"${a.topic.title}"`);
    const r = await createScriptVersion({
      scriptId: existing?.id ?? null, enrollmentId: a.enrollmentId, monthId: a.monthId, topicId: a.topic.id, parts, source: "AI", createdBy: requestedBy, status: "DRAFT",
      basedOnVersionId: existing?.currentVersionId ?? null, interviewId, answerIds: a.answerIds, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId,
      validation: { ok: validation.ok, findings: validation.findings }, gaps: [...a.input.gaps, ...gaps],
      changeSummary: existing ? "New draft from the changed answers — the earlier version is kept." : `Drafted from ${a.input.completeness.substantiveAnswered}/${a.input.completeness.substantiveTotal} substantive answers`,
    });
    await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
    await releaseRunKey(run.runId);
    await prisma.contentTopic.updateMany({ where: { id: a.topic.id!, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    return { scriptId: r.scriptId, versionId: r.versionId, ok: validation.ok, gaps: a.input.gaps.length + gaps.length };
  } finally {
    await releaseRunKey(run.runId); // idempotent; frees the key if the write above threw
  }
}

/**
 * Revise / regenerate: a NEW version based on the current one, with the
 * instruction applied. The current version — and any manual edit in it — is
 * never overwritten; regeneratedSections says what changed.
 */
export async function reviseScript(scriptId: string, instructions: string, requestedBy: string, source: "REVISION" | "CLIENT_REQUEST" = "REVISION"): Promise<{ versionId: string; versionNo: number }> {
  const head = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true } });
  if (!head) throw new Error("Script not found.");
  // Historical imports are records of what was filmed — the AI never rewrites them (Jordan's ruling).
  if (head.historical) throw new Error("This is an imported historical script — it is not revised; draft a new script for the topic instead.");
  const baseId = await ensureScriptVersioned(scriptId);
  const [s, base] = await Promise.all([prisma.contentScript.findUnique({ where: { id: scriptId } }), prisma.contentScriptVersion.findUnique({ where: { id: baseId } })]);
  if (!s || !base) throw new Error("Script not found.");
  const built = await buildClientContext(s.enrollmentId, { monthId: s.monthId });
  const topic = s.topicId ? (await policyTopic(s.topicId)).topic : makeTopic({ title: s.title, pillarName: base.categoryLabel ?? "", clientId: s.clientId });
  // Same other-client scrub as the first draft — a call excerpt naming another enrolled client never reaches a revision prompt either.
  const rawExcerpts = s.topicId ? await excerptsForTopic(s.topicId, s.monthId) : [];
  const scrub = await scrubOtherClients(s.clientId, rawExcerpts.map((e) => e.text));
  const bundle = buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: rawExcerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: true });
  const user = `${bundle.user}\n\nCURRENT VERSION (v${base.versionNo}) — keep what already works, change only what the reviewer asks:\n${base.body}\n\nREVIEWER'S INSTRUCTION: ${instructions.trim().slice(0, 2000)}`;
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_revise", enrollmentId: s.enrollmentId, clientId: s.clientId, scope: { scriptId, basedOnVersionId: baseId }, inputRefs: { ...built.inputRefs, instruction: sha256(instructions) },
    promptKey: "script", promptVersion: SCRIPT_PROMPT_VERSION, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: false, dedupeKey: `revise:${scriptId}`,
    system: bundle.system, prompt: user, schema: bundle.outputSchema, maxTokens: 3000,
  });
  const { parts, validation, gaps } = partsFromGenerated(run.output, base.pillarId, s.clientId);
  // The reviewer's revision must not silently recategorise the script.
  parts.categoryLabel = base.categoryLabel ?? parts.categoryLabel;
  parts.pillarId = base.pillarId;
  if (!parts.title) parts.title = base.title;
  const changed = (["hook", "points", "close", "captionCta"] as const).filter((k) => JSON.stringify(k === "points" ? parts.points.map((p) => p.text) : parts[k] ?? null) !== JSON.stringify(k === "points" ? pointsFromJson(base.pointsJson).map((p) => p.text) : base[k] ?? null));
  const r = await createScriptVersion({
    scriptId, enrollmentId: s.enrollmentId, monthId: s.monthId, topicId: s.topicId, parts, source, basedOnVersionId: baseId, regeneratedSections: changed, createdBy: requestedBy, status: "INTERNAL_REVIEW",
    interviewId: s.interviewId, callRecordId: s.callRecordId, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId, validation: { ok: validation.ok, findings: validation.findings }, gaps,
    changeSummary: `${source === "CLIENT_REQUEST" ? "Client suggestion applied" : "Revised"}: ${instructions.trim().slice(0, 160)}`,
  });
  await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
  return { versionId: r.versionId, versionNo: r.versionNo };
}

// --- topic refresh ------------------------------------------------------------------

type BankOut = { complete: boolean; pillars: { pillarName: string; topics: { title: string; description: string; audienceNeed: string; businessGoal: string; intendedMessage: string; sourceRef: string | null }[] }[]; gaps: Gap[] };

/** The AI half of a BANK / REFRESH run: prompt from the policy, validated, deduped against archived concepts, stored as PENDING suggestions. */
export async function executeTopicRefreshRun(runId: string, opts: { unattended: boolean; pillarId?: string | null; count?: number | null; /** Keep only the top N new suggestions (single-suggestion regeneration = 1). */ keep?: number | null }): Promise<void> {
  const run = await prisma.contentTopicRefreshRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Run not found.");
  const built = await buildClientContext(run.enrollmentId);
  const pillars = await listPillars(run.enrollmentId);
  const strategyPillars = built.ctx.strategy?.document?.contentPillars.pillars ?? [];
  const missing: string[] = [];
  if (!built.ctx.strategy?.document) missing.push("An APPROVED strategy for this client — the bank is built from its pillars, goals and audience. Import or draft one on the Strategy tab and approve it.");
  if (!pillars.length) missing.push("Content pillars on this client (they are created when a strategy is approved).");
  if (!strategyPillars.length && built.ctx.strategy?.document) missing.push("The approved strategy defines no pillars — add a 'Content Pillars' section with Pillar 1: … lines.");
  if (missing.length) { await finishRefreshRun(runId, { status: "NEEDS_INPUT", missingContext: { missing } }); return; }
  // The prompt's count lives in the policy's band (the bank prompt refuses
  // anything outside 10–15); a single-suggestion regeneration asks for the
  // policy count and KEEPS one (opts.keep) — never a forked prompt rule.
  const perPillar = opts.count ?? run.topicsPerPillar ?? GENERATION_POLICY.topicsPerPillar.default;
  const existingRows = await prisma.contentTopic.findMany({ where: { enrollmentId: run.enrollmentId }, select: { title: true, status: true, pillarId: true, pillar: true, rejectionReason: true, archiveReason: true, clientDeclinedAt: true, clientDeclineReason: true } });
  const nameOf = (id: string | null, label: string | null) => pillars.find((p) => p.id === id)?.name ?? label ?? "(no pillar)";
  // A topic the client said "not interested" to (CP-07) reads to the model as
  // ARCHIVED with their reason, and blockedTopicHashes withholds it below too.
  const existing = existingRows.map((t) => ({ title: t.title, pillarName: nameOf(t.pillarId, t.pillar), state: (t.clientDeclinedAt || t.status === "REJECTED" || t.status === "ARCHIVED" ? "ARCHIVED" : t.status === "SELECTED" || t.status === "SCRIPTED" ? "SELECTED" : ["FILMED", "DELIVERED", "EDITING"].includes(t.status) ? "FILMED" : "SUGGESTED") as Topic["state"], note: t.clientDeclinedAt ? `client not interested${t.clientDeclineReason ? `: ${t.clientDeclineReason}` : ""}` : t.rejectionReason ?? t.archiveReason ?? null }));
  const prevArchivedSugg = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: run.enrollmentId, disposition: "ARCHIVED" }, select: { title: true, pillarId: true } });
  for (const s of prevArchivedSugg) existing.push({ title: s.title, pillarName: nameOf(s.pillarId, null), state: "ARCHIVED", note: "archived suggestion" });
  const ctx: ClientContext = opts.pillarId
    ? { ...built.ctx, strategy: built.ctx.strategy && built.ctx.strategy.document ? { ...built.ctx.strategy, document: { ...built.ctx.strategy.document, contentPillars: { ...built.ctx.strategy.document.contentPillars, pillars: built.ctx.strategy.document.contentPillars.pillars.filter((p) => normalizeTitle(p.name) === normalizeTitle(nameOf(opts.pillarId!, null))) } } } : built.ctx.strategy }
    : built.ctx;
  // Suggestions still waiting on Jordan from earlier runs count as "existing" for
  // the prompt AND the dedupe below — a second click must not offer the same title twice.
  const pendingRows = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: run.enrollmentId, disposition: "PENDING" }, select: { title: true, pillarId: true } });
  for (const s of pendingRows) existing.push({ title: s.title, pillarName: nameOf(s.pillarId, null), state: "SUGGESTED", note: "already suggested, awaiting review" });
  const bundle = buildTopicBankPrompt(ctx, { topicsPerPillar: Math.min(Math.max(perPillar, GENERATION_POLICY.topicsPerPillar.min), GENERATION_POLICY.topicsPerPillar.max), existingTopics: existing, refresh: run.kind === "REFRESH" });
  const runRes = await runAiJson<BankOut>({
    kind: run.kind === "BANK" ? "topic_bank" : "topic_refresh", enrollmentId: run.enrollmentId, clientId: run.clientId, scope: { refreshRunId: runId, pillarId: opts.pillarId ?? null }, inputRefs: { ...built.inputRefs, existingTopics: existing.length },
    promptKey: "topic-bank", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: run.requestedBy ?? "system", unattended: opts.unattended, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 16_000,
  });
  const out = runRes.output;
  const [blocked, pendingHashes] = await Promise.all([blockedTopicHashes(run.enrollmentId), pendingSuggestionHashes(run.enrollmentId)]);
  const existingHashes = new Set([...existingRows.filter((t) => t.status !== "REJECTED" && t.status !== "ARCHIVED").map((t) => topicDedupeHash(t.title)), ...pendingHashes]);
  const bank: TopicBank = { clientId: run.clientId, clientName: built.ctx.clientName, intro: [], strategyVersion: built.strategyLabel, stamp: policyStamp(built.strategyLabel), pillars: [] };
  for (const p of Array.isArray(out.pillars) ? out.pillars : []) {
    const pillarId = await resolvePillarByLabel(run.enrollmentId, p.pillarName);
    bank.pillars.push({ pillarId, name: p.pillarName, purpose: null, topics: (p.topics ?? []).map((t) => makeTopic({ title: t.title, pillarName: p.pillarName, description: t.description, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: "GENERATED", sourceRef: t.sourceRef, clientId: run.clientId, pillarRef: { pillarId, pillarName: p.pillarName } })) });
  }
  const validation = validateTopicBank(bank, { topicsPerPillar: perPillar, mode: "generated", strategyPillarNames: strategyPillars.map((p) => p.name) });
  let created = 0, resurfaced = 0, duplicates = 0, notKept = 0;
  const rows: Prisma.ContentTopicSuggestionCreateManyInput[] = [];
  for (const p of bank.pillars) {
    if (!p.pillarId) continue; // an unknown pillar name is a finding, never a new pillar
    let rank = 0;
    for (const t of p.topics) {
      const hash = topicDedupeHash(t.title);
      if (blocked.has(hash)) { resurfaced++; continue; } // archived/rejected concepts never come back
      if (existingHashes.has(hash)) { duplicates++; continue; }
      if (opts.keep && rank >= opts.keep) { notKept++; continue; } // "regenerate ONE": the replacement is the first fresh idea, the rest are not stored
      existingHashes.add(hash);
      rows.push({ refreshRunId: runId, enrollmentId: run.enrollmentId, clientId: run.clientId, pillarId: p.pillarId, kind: "BANK", rank: ++rank, title: t.title.slice(0, 200), description: t.description, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, rationale: t.sourceRef ? `Grounded in: ${t.sourceRef}` : "Inferred from the pillar's focus areas", dedupeHash: hash });
      created++;
    }
  }
  if (rows.length) await prisma.contentTopicSuggestion.createMany({ data: rows });
  await setRunOutputRef(runRes.runId, `ContentTopicRefreshRun:${runId}`);
  const unknownPillars = validation.findings.filter((f) => f.code === "pillar.unknown").map((f) => f.message);
  const gaps = [...(Array.isArray(out.gaps) ? out.gaps : []), ...validation.gaps];
  const status = created === 0 ? "NEEDS_INPUT" : "SUCCEEDED";
  await finishRefreshRun(runId, {
    status, generatedCount: created, pillarCount: bank.pillars.length, aiRunId: runRes.runId,
    missingContext: gaps.length || unknownPillars.length || !out.complete ? { gaps: gaps.map((g) => g.text), unknownPillars, complete: out.complete === true } : undefined,
    changeSummary: `${created} new suggestion${created === 1 ? "" : "s"}${opts.keep ? ` (kept ${created} of ${created + notKept} fresh ideas as the replacement)` : ""} · ${duplicates} already in the bank · ${resurfaced} archived concept${resurfaced === 1 ? "" : "s"} withheld · ${validation.duplicates.length} near-duplicate warning${validation.duplicates.length === 1 ? "" : "s"}${out.complete === false ? " · the model reported it could not reach the count at the quality bar" : ""}`,
  });
}

/** ONE replacement suggestion for a pillar (the per-suggestion "regenerate"): the prompt runs at the policy's count, and exactly one fresh idea is kept — what the button promises. */
export async function executeSingleSuggestionRegeneration(s: { enrollmentId: string; pillarId: string | null; refreshRunId: string }, by: string): Promise<{ runId: string }> {
  const { startTopicRefresh } = await import("@/lib/contentTopics");
  return { runId: (await startTopicRefresh({ enrollmentId: s.enrollmentId, kind: "REFRESH", requestedBy: by, pillarId: s.pillarId, keep: 1 })).runId };
}

// (The AI-phrased interview follow-up was removed Sep 17: the interview uses the
// policy's house follow-up wording — buildInterviewFollowUpPrompt stays in the
// policy layer for the day the UI wires it, and nothing here pretends it is live.)

// --- call analysis (transcript → proposals, never selections) --------------------------------

type Excerpt = { speaker: "client" | "jordan" | "third-party"; speakerName?: string | null; time?: string | null; text: string };
type Analysis = {
  callKind: "planning" | "discovery" | "review" | "other";
  plannedMonthKey: string | null;
  selectedTopics: { title: string; concept: string; pillar: string | null; excerpts: Excerpt[] }[];
  discussedTopics: { title: string; concept: string; pillar: string | null; excerpts: Excerpt[] }[];
  rejectedIdeas: { title: string; reason: string | null }[];
  // CP-11: proposedValue / section / proposedText / confidential — what exactly
  // a preference or a strategy section would change to (profileFields.ts).
  facts: { body: string; category: FactCategory; fieldKey: string | null; scope: "PERMANENT" | "MONTH" | "PROJECT"; speaker: string | null; confidential: boolean; confidence: number; excerpt: Excerpt | null; proposedValue?: string | null }[];
  strategyProposals: { kind: "STRATEGY" | "PILLAR" | "AUDIENCE" | "POSITIONING" | "PREFERENCE"; summary: string; impact: string | null; section?: string | null; proposedText?: string | null; confidential?: boolean }[];
  priorities: string[];
  todos: string[];
};

const EXCERPT_SCHEMA = { type: "object", required: ["speaker", "text"], properties: { speaker: { type: "string", enum: ["client", "jordan", "third-party"] }, speakerName: { type: ["string", "null"] }, time: { type: ["string", "null"] }, text: { type: "string" } } };
const TOPIC_SCHEMA = { type: "object", required: ["title", "concept", "excerpts"], properties: { title: { type: "string" }, concept: { type: "string" }, pillar: { type: ["string", "null"] }, excerpts: { type: "array", items: EXCERPT_SCHEMA } } };
const ANALYSIS_SCHEMA = {
  type: "object",
  required: ["callKind", "plannedMonthKey", "selectedTopics", "discussedTopics", "rejectedIdeas", "facts", "strategyProposals", "priorities", "todos"],
  properties: {
    callKind: { type: "string", enum: ["planning", "discovery", "review", "other"] },
    plannedMonthKey: { type: ["string", "null"], description: "YYYY-MM the selected topics are FOR, or null" },
    selectedTopics: { type: "array", items: TOPIC_SCHEMA, description: "Topics the CLIENT explicitly agreed to film — each with a client-spoken excerpt proving it" },
    discussedTopics: { type: "array", items: TOPIC_SCHEMA, description: "Ideas raised but not agreed — saved for the bank" },
    rejectedIdeas: { type: "array", items: { type: "object", required: ["title"], properties: { title: { type: "string" }, reason: { type: ["string", "null"] } } } },
    facts: { type: "array", items: { type: "object", required: ["body", "category", "scope", "confidential", "confidence"], properties: { body: { type: "string" }, category: { type: "string", enum: ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "PERFORMANCE_REPORTED", "DECISION", "COMMITMENT", "FEEDBACK", "PROPOSED_CHANGE"] }, fieldKey: { type: ["string", "null"], description: "e.g. editing.music, editing.pace, editing.captions, production.location_preference, production.preferred_days, production.wardrobe, production.teleprompter, brand.fonts, brand.website, brand.social, brand.voice — or null" }, scope: { type: "string", enum: ["PERMANENT", "MONTH", "PROJECT"] }, speaker: { type: ["string", "null"] }, confidential: { type: "boolean" }, confidence: { type: "number" }, excerpt: { anyOf: [EXCERPT_SCHEMA, { type: "null" }] }, proposedValue: { type: ["string", "null"], description: "When the client CHANGED a standing preference: the new standing value in a few words (e.g. 'Calm acoustic'). Otherwise null." } } } },
    strategyProposals: { type: "array", items: { type: "object", required: ["kind", "summary"], properties: { kind: { type: "string", enum: ["STRATEGY", "PILLAR", "AUDIENCE", "POSITIONING", "PREFERENCE"] }, summary: { type: "string" }, impact: { type: ["string", "null"] }, section: { type: ["string", "null"], description: "The heading, EXACTLY as listed under APPROVED STRATEGY SECTION HEADINGS, of the ONE section this changes — or null" }, proposedText: { type: ["string", "null"], description: "Replacement text for that one section only, in the section's own style — or null" }, confidential: { type: "boolean", description: "true when this was said in confidence or is commercially sensitive" } } } },
    priorities: { type: "array", items: { type: "string" } },
    todos: { type: "array", items: { type: "string" } },
  },
};

const ANALYSIS_SYSTEM = (videosOwed: number, history: string) =>
  "You are processing a call transcript for a real-estate agent's monthly video program. FIRST judge what kind of call this is (planning / discovery / review / other). " +
  "If it is a planning session, set plannedMonthKey to the month the topics are FOR (a call in the last third of a month usually plans the NEXT month). Use the call date in the prompt.\n" +
  "Report what the CLIENT actually agreed to, not everything mentioned: selectedTopics need a client-spoken excerpt each; discussedTopics are ideas without agreement; rejectedIdeas were explicitly declined. " +
  "facts: NEW durable facts about the agent (preferences, decisions, commitments, reported results) — quote or closely paraphrase, with speaker and an excerpt; scope PROJECT for 'let's try X on this one', MONTH for this month only, PERMANENT otherwise; anything told in confidence or commercially sensitive is confidential=true. " +
  "strategyProposals: only when the client changes positioning, audience, pillars or a standing preference — a proposal for staff, never a rewrite. Name the ONE approved section it changes (its heading exactly) and give replacement text for that section only; leave both null if no single section fits. Anything said in confidence is confidential=true. " +
  "When a fact CHANGES a standing preference (music, pace, captions, wardrobe, filming days or location, fonts, website, social), set proposedValue to the new value in a few words; a person decides whether to apply it. priorities: this month's campaign priorities in the client's words. todos: action items either side committed to.\n" +
  `The plan owes ${videosOwed} videos this month — do not force the count.\n` +
  CONTENT_RULES + "\n\n" + SPEAKER_ATTRIBUTION_RULE + "\n\n" + NO_INVENTION_RULE + "\n\n" +
  "Topics already in this agent's history (avoid lazy duplicates; a fresh angle on an old theme is fine):\n" + history;

export type AnalysisResult = { callKind: string; plannedMonthKey: string | null; targetMonthId: string; proposedSelections: number; keptSelections: number; withheldSelections: number; discussed: number; rejected: number; facts: number; confidentialFacts: number; proposals: number; priorities: number; todos: number; runId: string };

/**
 * Analyse a transcript for an enrollment: topics become PROPOSED selections
 * (with their excerpts as evidence) or bank ideas, facts become PROPOSED
 * ClientFacts, positioning changes become strategy proposals, priorities
 * land on the month. Nothing is selected, approved or accepted by this.
 */
export async function analyzeTranscriptText(o: { enrollmentId: string; clientId: string; monthId: string; monthKey: string; transcript: string; callDate: Date | null; videosOwed: number; requestedBy: string; unattended: boolean; callRecordId?: string | null; transcriptSourceId?: string | null }): Promise<AnalysisResult> {
  const built = await buildClientContext(o.enrollmentId, { monthId: o.monthId, monthKey: o.monthKey });
  const historyRows = await prisma.contentTopic.findMany({ where: { enrollmentId: o.enrollmentId }, orderBy: { createdAt: "desc" }, take: 120, select: { title: true, status: true } });
  const history = historyRows.length ? historyRows.map((t) => `- [${t.status}] ${t.title}`).join("\n") : "none yet";
  const context = built.ctx.strategy?.document ? `APPROVED STRATEGY (${built.strategyLabel}):\n${renderStrategy(built.ctx.strategy.document, { preserveSourceHeadings: true })}` : "APPROVED STRATEGY: none on file.";
  const facts = [...(built.ctx.preferences?.explicit ?? []), ...(built.ctx.knownFacts ?? [])];
  // CP-11: the approved strategy's own section headings, so a proposal can
  // name the ONE section it changes (resolved back to its id on the way in).
  const headings = (await approvedStrategy(o.enrollmentId).catch(() => null))?.stored.sections.map((s) => s.heading).filter(Boolean) ?? [];
  const run = await runAiJson<Analysis>({
    kind: "call_analysis", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { monthId: o.monthId, callRecordId: o.callRecordId ?? null, transcriptSourceId: o.transcriptSourceId ?? null }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript) },
    promptKey: "call-analysis", promptVersion: `${GENERATION_POLICY_VERSION}/analysis.3`, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: o.callRecordId ? `analyze:${o.callRecordId}` : `analyze:month:${o.monthId}`,
    system: ANALYSIS_SYSTEM(o.videosOwed, history),
    prompt: `CLIENT: ${built.ctx.clientName} (id ${o.clientId})\nCALL DATE: ${o.callDate ? o.callDate.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }) : `sometime in ${o.monthKey}`}\n\n${context}\n\n${headings.length ? `APPROVED STRATEGY SECTION HEADINGS (use one exactly in strategyProposals[].section):\n${headings.map((h) => `- ${h}`).join("\n")}\n\n` : ""}${facts.length ? `ACCEPTED FACTS ON FILE:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` : ""}TRANSCRIPT:\n${o.transcript.slice(0, 150_000)}`,
    schema: ANALYSIS_SCHEMA, maxTokens: 10_000,
  });
  const out = run.output;
  // Which month the selections are FOR (a late-month call plans the next month).
  let targetMonthId = o.monthId;
  const planned = typeof out.plannedMonthKey === "string" && /^\d{4}-\d{2}$/.test(out.plannedMonthKey) ? out.plannedMonthKey : null;
  if (planned && planned !== o.monthKey) {
    const { etMonthKey } = await import("@/lib/contentProgram");
    const enr = await prisma.contentEnrollment.findUnique({ where: { id: o.enrollmentId }, select: { videosPerMonth: true } });
    const target = await prisma.contentMonth.upsert({
      where: { enrollmentId_monthKey: { enrollmentId: o.enrollmentId, monthKey: planned } }, update: {},
      create: { enrollmentId: o.enrollmentId, clientId: o.clientId, monthKey: planned, videosOwed: enr?.videosPerMonth ?? 4, strategyCallStatus: "COMPLETED", ...(planned < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}) },
      select: { id: true },
    });
    targetMonthId = target.id;
  }
  const actor: Actor = { kind: "AI" };
  const sourceRef = o.callRecordId ? `ProgramCallRecord:${o.callRecordId}` : `ContentMonth:${o.monthId}`;
  const toExcerpts = (ex: Excerpt[] | undefined): SourceExcerpt[] => (Array.isArray(ex) ? ex : []).filter((x) => x && typeof x.text === "string").slice(0, 8).map((x) => ({ speaker: x.speaker === "client" || x.speaker === "jordan" ? x.speaker : "third-party", speakerName: x.speakerName ?? null, source: `call ${o.monthKey}${x.time ? ` ${x.time}` : ""}`, text: x.text.slice(0, 1200) }));
  let proposedSelections = 0, discussed = 0, kept = 0, withheld = 0;
  for (const t of Array.isArray(out.selectedTopics) ? out.selectedTopics : []) {
    if (!t.title?.trim()) continue;
    const excerpts = toExcerpts(t.excerpts);
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, concept: t.concept, pillarLabel: t.pillar, source: "strategy_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", actor, eventKind: "DISCUSSED", evidence: { excerpts }, note: "Raised on the call" });
    // A call PROPOSES; a person reconciles (spec §5: discussed ≠ selected). A
    // re-analysis never downgrades what a person already decided: the topic
    // layer keeps SELECTED/RECONCILED rows, leaves REMOVED ones removed and
    // withholds rejected/archived topics — each with the mention on the history.
    const sel = await selectTopicForMonth(r.id, targetMonthId, { source: "call", actor, callRecordId: o.callRecordId ?? null, evidence: { excerpts, clientSpoken: excerpts.some((e) => e.speaker === "client") }, status: "PROPOSED" });
    if (sel.outcome === "PROPOSED") proposedSelections++;
    else if (sel.outcome === "KEPT") kept++;
    else withheld++;
  }
  for (const t of Array.isArray(out.discussedTopics) ? out.discussedTopics : []) {
    if (!t.title?.trim()) continue;
    const excerpts = toExcerpts(t.excerpts);
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, concept: t.concept, pillarLabel: t.pillar, source: "strategy_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", actor, eventKind: "DISCUSSED", evidence: { excerpts } });
    if (!r.existed) discussed++;
    // An existing topic raised again: the mention lands on its history, nothing else moves.
    else await recordTopicEvent(r.id, o.enrollmentId, "DISCUSSED", actor, { monthId: targetMonthId, sourceRef, evidence: { excerpts }, note: "Raised again on the call — no status changed" });
  }
  // Ideas the client declined on the call are PROPOSED rejections: the model
  // reports them, a person rules (a REJECTED topic is withheld from every future
  // refresh, so that ruling is never the model's — review finding).
  let rejected = 0;
  for (const t of Array.isArray(out.rejectedIdeas) ? out.rejectedIdeas : []) {
    if (!t.title?.trim()) continue;
    const note = `Declined on the call per the transcript${t.reason ? `: ${t.reason}` : ""} — a proposed rejection; reject it on Video Topics to make it stick`;
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, source: "strategy_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", proposedState: "REJECTED", actor, eventKind: "DISCUSSED", note });
    if (r.existed) await recordTopicEvent(r.id, o.enrollmentId, "DISCUSSED", actor, { monthId: targetMonthId, sourceRef, note });
    else await prisma.contentTopic.update({ where: { id: r.id }, data: { rejectionReason: t.reason ?? null } });
    rejected++;
  }
  // Facts and strategy proposals (CP-11): profileFields.applyCallKnowledge —
  // the same createFact as before, plus a PROPOSED profile change when a
  // preference changed, section-targeted strategy proposals, and confidential
  // proposals routed to a locked fact. Separate so a drill can feed it a
  // fixture model output; nothing it writes is applied without a person.
  const { applyCallKnowledge } = await import("@/lib/profileFields");
  const knowledge = await applyCallKnowledge(
    { enrollmentId: o.enrollmentId, clientId: o.clientId, targetMonthId, callRecordId: o.callRecordId ?? null, transcriptSourceId: o.transcriptSourceId ?? null, callDate: o.callDate, unattended: o.unattended, sourceRef, runId: run.runId },
    { facts: out.facts, strategyProposals: out.strategyProposals },
  );
  const factsN = knowledge.facts, confidentialN = knowledge.confidentialFacts, proposals = knowledge.proposals + knowledge.fieldProposals;
  const priorities = Array.isArray(out.priorities) ? out.priorities.filter((x) => typeof x === "string" && x.trim()) : [];
  if (priorities.length) {
    // Priorities a person typed (sourceRef "manual:…") are kept; the call's are
    // merged in behind them, never written over them.
    const cur = await prisma.contentMonth.findUnique({ where: { id: targetMonthId }, select: { prioritiesJson: true, prioritiesSourceRef: true } });
    const manual = cur?.prioritiesSourceRef?.startsWith("manual:") ? monthPriorities(cur.prioritiesJson) : [];
    const merged = [...manual, ...priorities.filter((p) => !manual.some((m) => m.trim().toLowerCase() === p.trim().toLowerCase()))];
    await setMonthPriorities(targetMonthId, merged, manual.length ? `${cur!.prioritiesSourceRef} + ${sourceRef}` : sourceRef);
  }
  const todos = Array.isArray(out.todos) ? out.todos.filter((x) => typeof x === "string" && x.trim()) : [];
  if (todos.length) {
    // Month notes are APPENDED, never overwritten (the old analyser wiped hand-typed notes).
    const m = await prisma.contentMonth.findUnique({ where: { id: o.monthId }, select: { notes: true } });
    const block = `Call to-dos (${o.callDate ? o.callDate.toISOString().slice(0, 10) : o.monthKey}):\n${todos.map((t) => `• ${t}`).join("\n")}`;
    if (!(m?.notes ?? "").includes(block)) await prisma.contentMonth.update({ where: { id: o.monthId }, data: { notes: [m?.notes, block].filter(Boolean).join("\n\n").slice(0, 8000) } });
  }
  await setRunOutputRef(run.runId, `ContentMonth:${targetMonthId}`);
  return { callKind: out.callKind, plannedMonthKey: planned, targetMonthId, proposedSelections, keptSelections: kept, withheldSelections: withheld, discussed, rejected, facts: factsN, confidentialFacts: confidentialN, proposals, priorities: priorities.length, todos: todos.length, runId: run.runId };
}

/**
 * THE ONE-TIME BRAND DISCOVERY CALL IS NOT A MONTH (6.2, Sep 25 2026; §3
 * "Initial discovery … not a monthly task").
 *
 * The call record honoured that (applyTarget files discovery on the
 * onboarding record, never a month), but its ANALYSIS went through the monthly
 * path: callAndTranscript upserted the month of the call's own date — creating
 * it with strategyCallStatus COMPLETED, which quietly satisfied the required
 * first strategy call without one — and the analyser then filed PROPOSED
 * selections on it, merged "priorities" and appended "call to-dos" to its
 * notes. Now a discovery transcript runs the SAME model call (same schema,
 * same dedupe key) and keeps only what discovery is for:
 *   · facts and strategy proposals (profileFields.applyCallKnowledge, with no
 *     month — a "this month only" fact is kept as permanent);
 *   · topics the client raised, as PROPOSED bank ideas with no month;
 *   · ideas they declined, as proposed rejections for a person to rule on.
 * No month is created or touched, no selection, no priorities, no to-dos.
 */
export type DiscoveryAnalysisResult = { callKind: string; bankIdeas: number; raisedAgain: number; rejected: number; facts: number; confidentialFacts: number; proposals: number; ignoredPriorities: number; ignoredTodos: number; runId: string };

export async function analyzeDiscoveryKnowledge(o: { enrollmentId: string; clientId: string; transcript: string; callRecordId: string; transcriptSourceId?: string | null; callDate: Date | null; requestedBy: string; unattended: boolean }): Promise<DiscoveryAnalysisResult> {
  const built = await buildClientContext(o.enrollmentId);
  const [historyRows, enrollment] = await Promise.all([
    prisma.contentTopic.findMany({ where: { enrollmentId: o.enrollmentId }, orderBy: { createdAt: "desc" }, take: 120, select: { title: true, status: true } }),
    prisma.contentEnrollment.findUnique({ where: { id: o.enrollmentId }, select: { videosPerMonth: true } }),
  ]);
  const history = historyRows.length ? historyRows.map((t) => `- [${t.status}] ${t.title}`).join("\n") : "none yet";
  const context = built.ctx.strategy?.document ? `APPROVED STRATEGY (${built.strategyLabel}):\n${renderStrategy(built.ctx.strategy.document, { preserveSourceHeadings: true })}` : "APPROVED STRATEGY: none on file yet — this call is where it comes from.";
  const facts = [...(built.ctx.preferences?.explicit ?? []), ...(built.ctx.knownFacts ?? [])];
  const headings = (await approvedStrategy(o.enrollmentId).catch(() => null))?.stored.sections.map((s) => s.heading).filter(Boolean) ?? [];
  const when = o.callDate ? o.callDate.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }) : "date not recorded";
  const run = await runAiJson<Analysis>({
    kind: "call_analysis", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { monthId: null, callRecordId: o.callRecordId, transcriptSourceId: o.transcriptSourceId ?? null, callType: "BRAND_DISCOVERY" }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript) },
    promptKey: "call-analysis", promptVersion: `${GENERATION_POLICY_VERSION}/analysis.3-discovery`, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    // The same key as the monthly path: one analysis per call record, whichever path asks.
    dedupeKey: `analyze:${o.callRecordId}`,
    system: ANALYSIS_SYSTEM(enrollment?.videosPerMonth ?? 4, history),
    prompt: `CALL TYPE: BRAND DISCOVERY — the client's one-time onboarding call. It plans NO month: set plannedMonthKey to null. Topics the client liked are ideas for their topic bank, not selections for a month. Leave priorities and todos empty.\nCLIENT: ${built.ctx.clientName} (id ${o.clientId})\nCALL DATE: ${when}\n\n${context}\n\n${headings.length ? `APPROVED STRATEGY SECTION HEADINGS (use one exactly in strategyProposals[].section):\n${headings.map((h) => `- ${h}`).join("\n")}\n\n` : ""}${facts.length ? `ACCEPTED FACTS ON FILE:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` : ""}TRANSCRIPT:\n${o.transcript.slice(0, 150_000)}`,
    schema: ANALYSIS_SCHEMA, maxTokens: 10_000,
  });
  const out = run.output;
  const actor: Actor = { kind: "AI" };
  const sourceRef = `ProgramCallRecord:${o.callRecordId}`;
  const toExcerpts = (ex: Excerpt[] | undefined): SourceExcerpt[] => (Array.isArray(ex) ? ex : []).filter((x) => x && typeof x.text === "string").slice(0, 8).map((x) => ({ speaker: x.speaker === "client" || x.speaker === "jordan" ? x.speaker : "third-party", speakerName: x.speakerName ?? null, source: `discovery call${x.time ? ` ${x.time}` : ""}`, text: x.text.slice(0, 1200) }));
  let bankIdeas = 0, raisedAgain = 0, rejected = 0;
  // Agreed or merely discussed, a discovery topic is a bank IDEA — never a selection.
  for (const t of [...(Array.isArray(out.selectedTopics) ? out.selectedTopics : []), ...(Array.isArray(out.discussedTopics) ? out.discussedTopics : [])]) {
    if (!t?.title?.trim()) continue;
    const excerpts = toExcerpts(t.excerpts);
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, concept: t.concept, pillarLabel: t.pillar, source: "discovery_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", actor, eventKind: "DISCUSSED", evidence: { excerpts }, note: "Raised on the brand discovery call" });
    if (!r.existed) bankIdeas++;
    else { raisedAgain++; await recordTopicEvent(r.id, o.enrollmentId, "DISCUSSED", actor, { monthId: null, sourceRef, evidence: { excerpts }, note: "Raised again on the brand discovery call — no status changed" }); }
  }
  for (const t of Array.isArray(out.rejectedIdeas) ? out.rejectedIdeas : []) {
    if (!t?.title?.trim()) continue;
    const note = `Declined on the discovery call per the transcript${t.reason ? `: ${t.reason}` : ""} — a proposed rejection; reject it on Video Topics to make it stick`;
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, source: "discovery_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", proposedState: "REJECTED", actor, eventKind: "DISCUSSED", note });
    if (r.existed) await recordTopicEvent(r.id, o.enrollmentId, "DISCUSSED", actor, { monthId: null, sourceRef, note });
    else await prisma.contentTopic.update({ where: { id: r.id }, data: { rejectionReason: t.reason ?? null } });
    rejected++;
  }
  const { applyCallKnowledge } = await import("@/lib/profileFields");
  const knowledge = await applyCallKnowledge(
    { enrollmentId: o.enrollmentId, clientId: o.clientId, targetMonthId: null, callRecordId: o.callRecordId, transcriptSourceId: o.transcriptSourceId ?? null, callDate: o.callDate, unattended: o.unattended, sourceRef, runId: run.runId },
    { facts: out.facts, strategyProposals: out.strategyProposals },
  );
  await setRunOutputRef(run.runId, sourceRef);
  const count = (x: unknown) => (Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.trim()).length : 0);
  return {
    callKind: out.callKind, bankIdeas, raisedAgain, rejected, facts: knowledge.facts, confidentialFacts: knowledge.confidentialFacts, proposals: knowledge.proposals + knowledge.fieldProposals,
    ignoredPriorities: count(out.priorities), ignoredTodos: count(out.todos), runId: run.runId,
  };
}

// --- the transcript-job handler registry (for W1-B's driver) ------------------------------------

export type TranscriptJobInput = { id: string; kind: string; callRecordId: string; transcriptSourceId?: string | null; enrollmentId?: string | null; requestedBy?: string | null; /** Refresh the driver's lease between long AI calls. */ heartbeat?: () => Promise<void> };
export type TranscriptJobOutcome = { ok: true; resultJson: Record<string, unknown>; aiRunId?: string | null } | { ok: false; paused: string } | { ok: false; waiting: string } | { ok: false; reviewReason?: string; error?: string; aiRunId?: string | null };

async function callAndTranscript(job: TranscriptJobInput) {
  const call = await prisma.programCallRecord.findUnique({ where: { id: job.callRecordId } });
  if (!call) return { error: "Call record not found." } as const;
  if (!call.enrollmentId || !call.clientId) return { reviewReason: "The call is not matched to a client yet — confirm the invitee first." } as const;
  // A04 (Sep 25 2026): an identity that became uncertain keeps its ids on the
  // record (so the month keeps its call on file), and that used to be all this
  // checked — so analysis and a client-facing strategy draft still ran for a
  // call whose owner was in question. It waits now, attempt given back, until
  // a person confirms the client (confirmCallRecordClient re-arms it).
  if (call.matchState !== "MATCHED" && call.matchState !== "CONFIRMED_BY_STAFF") return { waiting: "the call's client is in question — confirm it on Settings → Calendly & calls" } as const;
  // CONFIRMED sources on this call only — never a candidate copy, never ContentMonth.transcriptText.
  const sources = job.transcriptSourceId
    ? await prisma.programTranscriptSource.findMany({ where: { id: job.transcriptSourceId, callRecordId: call.id, matchState: "CONFIRMED" } })
    : await prisma.programTranscriptSource.findMany({ where: { callRecordId: call.id, matchState: "CONFIRMED", text: { not: null } }, orderBy: { version: "desc" } });
  const text = sources.map((s) => s.text ?? "").filter(Boolean).join("\n\n----\n\n");
  if (!text.trim()) return { reviewReason: "No confirmed transcript text on this call." } as const;
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: call.enrollmentId }, select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true } });
  if (!enrollment) return { error: "Enrollment not found." } as const;
  // Brand discovery plans no month (6.2): nothing is read, created or upserted.
  if (call.callType === "BRAND_DISCOVERY") return { call, text, enrollment, month: null, sourceId: sources[0]?.id ?? null } as const;
  // The month the call plans: explicit on the record; else its target key; else the call's own month.
  const { etMonthKey } = await import("@/lib/contentProgram");
  const monthKey = call.targetMonthKey ?? etMonthKey(call.scheduledStart ?? new Date());
  const month = call.monthId
    ? await prisma.contentMonth.findUnique({ where: { id: call.monthId } })
    : await prisma.contentMonth.upsert({ where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey } }, update: {}, create: { enrollmentId: enrollment.id, clientId: enrollment.clientId, monthKey, videosOwed: enrollment.videosPerMonth, strategyCallStatus: "COMPLETED" } });
  if (!month) return { error: "Month not found." } as const;
  return { call, text, enrollment, month, sourceId: sources[0]?.id ?? null } as const;
}

/**
 * Handlers for ProgramTranscriptJob kinds. W1-B's driver leases the job,
 * checks the transcript_jobs switch, calls this, and records the outcome on
 * the job row. Every AI call inside is unattended → gated by ai_runs.
 */
export async function runTranscriptJob(job: TranscriptJobInput): Promise<TranscriptJobOutcome> {
  const requestedBy = job.requestedBy ?? "cron";
  const unattended = !job.requestedBy || job.requestedBy === "cron" || job.requestedBy === "system";
  try {
    const ct = await callAndTranscript(job);
    if ("error" in ct) return { ok: false, error: ct.error };
    if ("reviewReason" in ct) return { ok: false, reviewReason: ct.reviewReason };
    if ("waiting" in ct) return { ok: false, waiting: ct.waiting };
    const { call, text, enrollment, month, sourceId } = ct;
    const beat = async () => { if (job.heartbeat) await job.heartbeat().catch(() => {}); };
    await beat();
    switch (job.kind) {
      case "ANALYZE":
      case "FACT_EXTRACT": {
        if (call.callType === "BRAND_DISCOVERY") {
          const r = await analyzeDiscoveryKnowledge({ enrollmentId: enrollment.id, clientId: enrollment.clientId, transcript: text, callRecordId: call.id, transcriptSourceId: sourceId, callDate: call.scheduledStart, requestedBy, unattended });
          await prisma.programCallRecord.update({ where: { id: call.id }, data: { analysisRunId: r.runId, transcriptState: "ANALYZED", analysisJson: JSON.stringify(r) } }).catch(() => {});
          return { ok: true, resultJson: { ...r }, aiRunId: r.runId };
        }
        if (!month) return { ok: false, error: "Month not found." };
        const r = await analyzeTranscriptText({ enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: month.id, monthKey: month.monthKey, transcript: text, callDate: call.scheduledStart, videosOwed: month.videosOwed, requestedBy, unattended, callRecordId: call.id, transcriptSourceId: sourceId });
        await prisma.programCallRecord.update({ where: { id: call.id }, data: { analysisRunId: r.runId, transcriptState: "ANALYZED", analysisJson: JSON.stringify(r) } }).catch(() => {});
        return { ok: true, resultJson: { ...r }, aiRunId: r.runId };
      }
      case "STRATEGY_DRAFT": {
        if (call.callType !== "BRAND_DISCOVERY") return { ok: false, reviewReason: "A strategy is drafted from a brand-discovery call only; this call is " + call.callType.toLowerCase() + "." };
        // A09: the call's own analysis is what marks the things said in
        // confidence, and the draft's transcript scrub reads those marks. So
        // the client-facing draft waits for it — unless the legacy sweep had
        // already analysed this transcript (then no ANALYZE was queued).
        if (!(await discoveryAnalysisDone(call.id, call.transcriptState, call.rawJson))) {
          return { ok: false, waiting: "waiting for the call's analysis to finish, so anything said in confidence is marked before a client-facing strategy is drafted" };
        }
        const r = await draftStrategyFromTranscript({ enrollmentId: enrollment.id, clientId: enrollment.clientId, transcript: text, callRecordId: call.id, callDate: call.scheduledStart, requestedBy, unattended });
        return { ok: true, resultJson: { strategyVersionId: r.versionId, versionNo: r.versionNo, gaps: r.gaps, stripped: r.stripped }, aiRunId: r.runId };
      }
      case "SCRIPT_DRAFT": {
        if (!month) return { ok: false, reviewReason: "A brand discovery call plans no month — scripts are drafted from a monthly planning call or the client's answers." };
        // Only RECONCILED/SELECTED topics get scripts; call-proposed ones wait for a person.
        const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: { in: ["SELECTED", "RECONCILED"] } }, select: { topicId: true } });
        const done: string[] = [];
        let skipped = 0;
        for (const s of sels) {
          const has = await prisma.contentScript.findFirst({ where: { topicId: s.topicId, monthId: month.id, historical: false }, select: { id: true } });
          if (has) { skipped++; continue; }
          await beat(); // one lease refresh per script — a month of drafts can outlast a 10-minute lease
          const g = await generateScriptForTopic({ topicId: s.topicId, monthId: month.id, requestedBy, unattended, callRecordId: call.id });
          done.push(g.versionId);
        }
        return { ok: true, resultJson: { versionIds: done, skipped, pending: (await prisma.contentTopicSelection.count({ where: { monthId: month.id, status: "PROPOSED" } })) } };
      }
      default:
        return { ok: false, error: `Unknown transcript job kind: ${job.kind}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A CLOSED SWITCH IS NOT A JOB THAT NEEDS A PERSON. This used to return
    // reviewReason, which parked the job in NEEDS_REVIEW and stamped the CALL
    // RECORD's transcriptState NEEDS_REVIEW with the error. Turning `ai_runs`
    // off — the stop button — therefore manufactured a queue of manual work
    // that did NOT resume when the switch came back on, and told Kyle three
    // calls needed him when none of them did. It is a pause: give the attempt
    // back and leave the job queued.
    if (e instanceof Error && e.name === "AutomationDisabledError") return { ok: false, paused: msg };
    return { ok: false, error: msg };
  }
}

/**
 * Has the discovery call's ANALYZE finished (A09)? Done = the job SUCCEEDED,
 * or the record says ANALYZED, or the legacy sweep had already analysed the
 * transcript (raw.analysis.skipped — then no ANALYZE was ever queued).
 */
export async function discoveryAnalysisDone(callRecordId: string, transcriptState: string, rawJson: string | null): Promise<boolean> {
  if (transcriptState === "ANALYZED") return true;
  try { if ((JSON.parse(rawJson ?? "{}") as { analysis?: { skipped?: string } }).analysis?.skipped) return true; } catch { /* unreadable raw — fall through to the job */ }
  const job = await prisma.programTranscriptJob.findFirst({ where: { callRecordId, kind: "ANALYZE" }, orderBy: { createdAt: "desc" }, select: { state: true } });
  return job?.state === "SUCCEEDED";
}

/** The calendar year in New York (a draft written on Dec 31 at 9 pm ET is that year's strategy). */
const etYear = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(d));

/**
 * Discovery call → a DRAFT strategy version in the house template, with gaps instead of inventions. Jordan approves.
 *
 * A08/A09 (Sep 25 2026): the draft carries the policy's Video Structure
 * Framework as its own section 4 (no "policy default" annotation); its year is
 * the New York year of the discovery call, not the server's UTC clock; and the
 * transcript and intake reach the model only after scrubTranscriptForGeneration
 * — the counts of what was held back are on the run's inputRefs.
 */
export async function draftStrategyFromTranscript(o: { enrollmentId: string; clientId: string; transcript: string; callRecordId?: string | null; callDate?: Date | null; intakeText?: string | null; requestedBy: string; unattended: boolean }): Promise<{ versionId: string; versionNo: number; gaps: number; runId: string; stripped: number }> {
  const built = await buildClientContext(o.enrollmentId);
  const scrub = await scrubTranscriptForGeneration(o.clientId, o.transcript);
  // The intake is stored as JSON; one answer per line, so a private answer is held back without the rest.
  const intakeLines = (() => { if (!o.intakeText) return null; try { return JSON.stringify(JSON.parse(o.intakeText), null, 1); } catch { return o.intakeText; } })();
  const intake = intakeLines ? await scrubTranscriptForGeneration(o.clientId, intakeLines) : null;
  const excerptCtx: ClientContext = { ...built.ctx, sourceExcerpts: [{ speaker: "client", speakerName: built.ctx.clientName, source: "discovery-call transcript (speaker turns not separated — treat lines as the client's only where the transcript says so)", text: scrub.text.slice(0, 120_000) }] };
  const bundle = buildStrategyPrompt(excerptCtx, { intakeText: intake?.text ?? null, priorStrategyNote: built.ctx.strategy ? `An approved strategy (${built.strategyLabel}) exists; this draft is a proposed new version, not a replacement.` : null });
  type StrategyOut = { clientName: string; subtitle: string; brandOverview: { coreValues: string; brandMessage: string; shortBrandStatement: string | null; brandVoice: string }; targetAudience: { primaryServiceAreas: string; pricePositioning: string | null; primaryClientTypes: string; longTermPositioningGoal: string }; contentGoals: string[]; contentPillars: { preamble: string; pillars: { name: string; purpose: string; focusAreas: string; contentApproach: string | null }[] }; framework: string; captionCtaExamples: string[]; strategicDirection: string; gaps: Gap[] };
  const run = await runAiJson<StrategyOut>({ kind: "strategy_draft", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript), stripped: scrub.stripped, strippedBy: scrub.reasons, intakeStripped: intake?.stripped ?? 0 }, promptKey: "strategy", promptVersion: `${GENERATION_POLICY_VERSION}/strategy.2-scrubbed`, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: o.callRecordId ? `strategy:${o.callRecordId}` : null, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 12_000 });
  const out = run.output;
  const doc: StrategyDocument = {
    clientName: out.clientName || built.ctx.clientName, year: etYear(o.callDate ?? new Date()), subtitle: out.subtitle,
    brandOverview: { coreValues: out.brandOverview.coreValues, brandMessage: out.brandOverview.brandMessage, shortBrandStatement: out.brandOverview.shortBrandStatement, brandVoice: out.brandOverview.brandVoice, otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: out.targetAudience.primaryServiceAreas, pricePositioning: out.targetAudience.pricePositioning, primaryClientTypes: out.targetAudience.primaryClientTypes, longTermPositioningGoal: out.targetAudience.longTermPositioningGoal, otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: out.contentGoals, numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: [out.contentPillars.preamble], pillars: out.contentPillars.pillars.map((p, i) => ({ number: i + 1, name: p.name, heading: `Pillar ${i + 1}: ${p.name}`, purpose: p.purpose, focusAreas: p.focusAreas, contentApproach: p.contentApproach, otherFields: [] })) },
    framework: policyFrameworkSection(), captionCtaExamples: { heading: "Caption CTA Examples", items: out.captionCtaExamples }, strategicDirection: { heading: "Strategic Direction", paragraphs: [out.strategicDirection] }, otherSections: [],
  };
  const text = renderStrategy(doc);
  const { stored } = structuredFromText(text);
  const gaps = Array.isArray(out.gaps) ? out.gaps : [];
  if (gaps.length) stored.sections.push({ id: "gaps", number: null, heading: "Gaps the draft could not fill (from the call)", order: stored.sections.length + 1, text: gaps.map((g) => `• [${g.kind}${g.field ? ` · ${g.field}` : ""}] ${g.text}${g.question ? ` → ${g.question}` : ""}`).join("\n") });
  const r = await createStrategyVersion({ enrollmentId: o.enrollmentId, stored, rawText: text, sourceKind: "discovery_call", sourceRef: o.callRecordId ?? "discovery transcript", callRecordId: o.callRecordId ?? null, aiRunId: run.runId, policyVersionId: built.policyVersionId, basedOnVersionId: built.strategyVersionId, createdBy: "ai", status: "DRAFT", changeSummary: `AI draft from the discovery call (${gaps.length} gap${gaps.length === 1 ? "" : "s"} listed, not filled${scrub.stripped ? `; ${scrub.stripped} transcript line${scrub.stripped === 1 ? "" : "s"} held back as confidential or about another client` : ""})` });
  await setRunOutputRef(run.runId, `ContentStrategyVersion:${r.versionId}`);
  return { versionId: r.versionId, versionNo: r.versionNo, gaps: gaps.length, runId: run.runId, stripped: scrub.stripped };
}

// ---------------------------------------------------------------------------
// REVISE THE STRATEGY WITH FEEDBACK (A08, Sep 25 2026) — Jordan's notes plus
// the client's own suggestions from the portal, in ONE staff-initiated run
// (unattended=false: a person pressed the button, so no sweep switch applies;
// ai_runs governs sweeps only). The model returns only the sections that
// change; deriveStrategyVersion swaps exactly those into a copy, so every
// other section is byte-identical by construction. The included client
// suggestions are claimed compare-and-set (PROPOSED → ACCEPTED, pointing at
// the new version) — this is the one revision; there is no client re-approval
// loop. The same notes + suggestions asked twice return the first result
// without a second paid run.
// ---------------------------------------------------------------------------
type RevisionOut = { changes: { sectionId: string; text: string }[]; summary: string; unaddressed: string[] };

export async function reviseStrategyWithFeedback(versionId: string, fb: { notes?: string | null; proposalIds?: string[] | null }, by: string): Promise<{ versionId: string; versionNo: number; existed: boolean; changedSections: string[]; unaddressed: string[]; ignoredSections: string[]; proposalsFolded: number; runId: string | null }> {
  const base = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId } });
  if (!base) throw new Error("Strategy version not found.");
  if (!["DRAFT", "INTERNAL_REVIEW", "APPROVED"].includes(base.status)) throw new Error(`v${base.versionNo} is ${base.status.toLowerCase()} — revise the newest version instead.`);
  const stored = parseStoredSections(base.sectionsJson);
  if (!stored?.sections.length) throw new Error("That version's sections can't be read.");
  const notes = (fb.notes ?? "").trim().slice(0, 4000);
  if (CONFIDENTIAL_RE.test(notes)) throw new Error("Take the [CONFIDENTIAL] marker out of your notes — the strategy is shown to the client.");
  const ids = [...new Set((fb.proposalIds ?? []).filter((x) => typeof x === "string" && x))];
  const proposals = ids.length
    ? await prisma.contentStrategyProposal.findMany({ where: { id: { in: ids }, enrollmentId: base.enrollmentId, status: "PROPOSED", OR: [{ targetKey: null }, { NOT: { targetKey: { startsWith: "profile." } } }] }, orderBy: { createdAt: "asc" } })
    : [];
  if (!notes && !proposals.length) throw new Error("Write what should change, or pick a client suggestion to fold in.");
  const feedbackKey = sha256(JSON.stringify({ base: base.id, notes, ids: proposals.map((p) => p.id).sort() })).slice(0, 24);
  // Asked before (a second click, a retry after a slow response): the version it made, no second run.
  const prior = await prisma.programAiRun.findFirst({ where: { kind: "strategy_revise", enrollmentId: base.enrollmentId, status: "SUCCEEDED", scopeJson: { contains: feedbackKey }, outputRef: { startsWith: "ContentStrategyVersion:" } }, orderBy: { createdAt: "desc" }, select: { id: true, outputRef: true } });
  if (prior?.outputRef) {
    const v = await prisma.contentStrategyVersion.findUnique({ where: { id: prior.outputRef.slice("ContentStrategyVersion:".length) }, select: { id: true, versionNo: true } });
    if (v) return { versionId: v.id, versionNo: v.versionNo, existed: true, changedSections: [], unaddressed: [], ignoredSections: [], proposalsFolded: 0, runId: prior.id };
  }
  const headingOf = (targetKey: string | null) => (targetKey?.startsWith("strategy.section:") ? stored.sections.find((x) => x.id === targetKey.slice("strategy.section:".length))?.heading ?? null : null);
  const toOf = (diffJson: string | null) => { try { return ((JSON.parse(diffJson ?? "[]") as { to?: string }[])[0]?.to ?? null) || null; } catch { return null; } };
  const built = await buildClientContext(base.enrollmentId);
  const bundle = buildStrategyRevisionPrompt(built.ctx, { label: `v${base.versionNo}`, sections: stored.sections.map((x) => ({ id: x.id, heading: x.heading, text: x.text })) }, {
    notes: notes || null,
    clientSuggestions: proposals.map((p) => ({ summary: p.summary, sectionHeading: headingOf(p.targetKey), proposedText: toOf(p.diffJson) })),
  });
  const run = await runAiJson<RevisionOut>({
    kind: "strategy_revise", enrollmentId: base.enrollmentId, clientId: base.clientId, scope: { strategyVersionId: base.id, proposalIds: proposals.map((p) => p.id), feedbackKey },
    inputRefs: { ...built.inputRefs, notesHash: sha256(notes), proposalIds: proposals.map((p) => p.id) }, promptKey: "strategy-revise", promptVersion: `${GENERATION_POLICY_VERSION}/strategy-revise.1`,
    policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: by, unattended: false,
    dedupeKey: `strategy-revise:${base.id}:${feedbackKey}`, holdDedupeKey: true, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 8000,
  });
  try {
    const known = new Set(stored.sections.map((x) => x.id));
    const replace = new Map<string, string>();
    const ignoredSections: string[] = [];
    for (const c of Array.isArray(run.output.changes) ? run.output.changes : []) {
      if (c && typeof c.sectionId === "string" && known.has(c.sectionId) && typeof c.text === "string" && c.text.trim()) replace.set(c.sectionId, c.text);
      else ignoredSections.push(String(c?.sectionId ?? "?"));
    }
    const unaddressed = Array.isArray(run.output.unaddressed) ? run.output.unaddressed.filter((x) => typeof x === "string" && x.trim()) : [];
    const summary = typeof run.output.summary === "string" && run.output.summary.trim() ? run.output.summary.trim() : "changes from the feedback";
    const r = await deriveStrategyVersion({ baseId: base.id, replace, by, sourceKind: "ai", aiRunId: run.runId, changeSummary: `Revised with feedback${proposals.length ? ` (${proposals.length} client suggestion${proposals.length === 1 ? "" : "s"} folded in)` : ""}: ${summary}` });
    let proposalsFolded = 0;
    if (r.versionId !== base.id && proposals.length) {
      const won = await prisma.contentStrategyProposal.updateMany({
        where: { id: { in: proposals.map((p) => p.id) }, status: "PROPOSED" },
        data: { status: "ACCEPTED", resolvedBy: by, resolvedAt: new Date(), resolutionNote: `Folded into v${r.versionNo} by a feedback revision`, resultVersionId: r.versionId },
      });
      proposalsFolded = won.count;
    }
    await setRunOutputRef(run.runId, `ContentStrategyVersion:${r.versionId}`);
    return { versionId: r.versionId, versionNo: r.versionNo, existed: r.existed, changedSections: r.changedSectionIds.map((id) => stored.sections.find((x) => x.id === id)?.heading ?? id), unaddressed, ignoredSections, proposalsFolded, runId: run.runId };
  } finally {
    await releaseRunKey(run.runId);
  }
}

/**
 * Phrase the six house questions FOR ONE TOPIC (F10).
 *
 * The roles, order and gap rules stay the policy's — only the sentences change,
 * and every key that comes back missing, short or still carrying a placeholder
 * falls straight back to the house template. So the worst case of a bad plan is
 * the behaviour we had before it existed.
 */
export async function planInterviewQuestions(interviewId: string, o: { requestedBy: string; unattended: boolean }): Promise<{ runId: string; questions: number; followUps: number }> {
  const { interviewPlanningContext } = await import("@/lib/contentInterview");
  const { INTERVIEW_QUESTION_PLAN } = await import("@/lib/contentPolicy");
  const { buildInterviewPlanPrompt } = await import("@/lib/contentPolicy/prompts");
  const ctxRow = await interviewPlanningContext(interviewId);
  const built = await buildClientContext(ctxRow.enrollmentId, { monthId: ctxRow.monthId });
  const bundle = buildInterviewPlanPrompt(built.ctx, { topic: ctxRow.topic, plan: INTERVIEW_QUESTION_PLAN });
  type PlanOut = { questions: { id: string; ask: string }[]; followUps: { key: string; ask: string }[] };
  const run = await runAiJson<PlanOut>({
    kind: "interview_plan", enrollmentId: ctxRow.enrollmentId, clientId: ctxRow.clientId, scope: { interviewId, topicId: ctxRow.topic.id, monthId: ctxRow.monthId },
    inputRefs: { ...built.inputRefs, topicTitle: ctxRow.topic.title }, promptKey: "interview-plan", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId,
    requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: `interview-plan:${interviewId}`,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 2000,
  });

  // Only ids the POLICY knows survive — a renamed or invented one is dropped
  // rather than stored, because assembleScriptInputs reads these by id.
  const allowed = new Set<string>(INTERVIEW_QUESTION_PLAN.map((q) => q.id));
  const allowedFu = new Set<string>(INTERVIEW_QUESTION_PLAN.flatMap((q) => q.followUps.map((f) => `${q.id}:fu:${f.when}`)));
  const usable = (t: unknown): t is string => typeof t === "string" && t.trim().length >= 12 && !t.includes("{{");
  const rows: { key: string; role: string; text: string }[] = [];
  const roleOf = new Map(INTERVIEW_QUESTION_PLAN.map((q) => [q.id as string, q.id]));
  for (const q of INTERVIEW_QUESTION_PLAN) {
    const hit = (run.output.questions ?? []).find((x) => x && x.id === q.id);
    // The house template is stored for anything unusable, exactly as
    // getOrCreateInterview would have — so the row is always complete.
    rows.push({ key: q.id, role: roleOf.get(q.id) ?? q.id, text: usable(hit?.ask) ? hit!.ask.trim() : q.template });
  }
  let followUps = 0;
  for (const f of run.output.followUps ?? []) {
    if (!f || !allowedFu.has(f.key) || !usable(f.ask)) continue;
    rows.push({ key: f.key, role: "FOLLOWUP", text: f.ask.trim() });
    followUps++;
  }
  const questions = rows.filter((r) => allowed.has(r.key) && !r.text.includes("{{")).length;
  await prisma.contentInterview.update({ where: { id: interviewId }, data: { questionPlanJson: JSON.stringify(rows), aiRunId: run.runId } });
  await setRunOutputRef(run.runId, `ContentInterview:${interviewId}`);
  return { runId: run.runId, questions, followUps };
}

export const GENERATION_KINDS: AiRunKind[] = ["call_analysis", "strategy_draft", "strategy_revise", "topic_bank", "topic_refresh", "recommendation", "script_draft", "script_revise", "interview_plan"];
