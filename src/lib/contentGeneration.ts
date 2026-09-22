import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { runAiJson, activePolicyVersion, setRunOutputRef, sha256, type AiRunKind } from "@/lib/aiRuns";
import { approvedStrategy, createStrategyVersion, createStrategyProposal, setMonthPriorities, monthPriorities, structuredFromText } from "@/lib/contentStrategy";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { createTopic, selectTopicForMonth, recordTopicEvent, blockedTopicHashes, pendingSuggestionHashes, finishRefreshRun, topicDedupeHash, type Actor } from "@/lib/contentTopics";
import { assembleInterviewInputs } from "@/lib/contentInterview";
import { createScriptVersion, ensureScriptVersioned, pointsFromJson, pillarNameOf, type VersionParts } from "@/lib/contentScripts";
import { createFact, factsForPrompt, factLines, CONFIDENTIAL_RE, type FactCategory } from "@/lib/clientFacts";
import { CONTENT_RULES } from "@/lib/contentPipeline";
import {
  buildScriptPrompt, buildTopicBankPrompt, buildStrategyPrompt, scriptFromGeneratorOutput, validateNewScript, validateTopicBank, renderStrategy,
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

async function otherClientNames(clientId: string): Promise<string[]> {
  const enrolled = await prisma.contentEnrollment.findMany({ where: { clientId: { not: clientId } }, select: { clientId: true } });
  const clients = await prisma.client.findMany({ where: { id: { in: enrolled.map((e) => e.clientId) } }, select: { name: true } });
  const out: string[] = [];
  for (const c of clients) {
    const n = (c.name ?? "").trim();
    const w = n.split(/\s+/);
    if (w.length >= 2) out.push(n, `${w[0]} ${w[1]}`);
  }
  return [...new Set(out.filter((n) => n.length >= 5))];
}

/** Drop every line that names another enrolled client. Deterministic; logged on the run's inputRefs. */
export async function scrubOtherClients(clientId: string, lines: string[]): Promise<{ kept: string[]; stripped: number }> {
  const names = await otherClientNames(clientId);
  if (!names.length) return { kept: lines, stripped: 0 };
  const re = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const kept = lines.filter((l) => !re.test(l));
  return { kept, stripped: lines.length - kept.length };
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
  const pillarName = (await pillarNameOf(t.pillarId, t.enrollmentId)) ?? t.pillar ?? "(no pillar)";
  return {
    row: t,
    topic: { id: t.id, clientId: t.clientId, title: t.title, description: t.concept, pillarRef: { pillarId: t.pillarId, pillarName }, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: "STAFF", sourceRef: null, state: "SELECTED", selectedForMonth: t.monthId, proposedState: null, importedMark: null, history: [], strategyVersion: null, stamp: null },
  };
}

/** Speaker-tagged excerpts recorded for a topic (from call analysis), newest selection first. */
async function excerptsForTopic(topicId: string, monthId: string | null): Promise<SourceExcerpt[]> {
  const sel = monthId ? await prisma.contentTopicSelection.findFirst({ where: { topicId, monthId }, select: { evidenceJson: true } }) : null;
  const ev = sel?.evidenceJson ?? (await prisma.contentTopicEvent.findFirst({ where: { topicId, evidenceJson: { not: null } }, orderBy: { createdAt: "desc" }, select: { evidenceJson: true } }))?.evidenceJson ?? null;
  if (!ev) return [];
  try {
    const v = JSON.parse(ev) as { excerpts?: SourceExcerpt[] } | SourceExcerpt[];
    const arr = Array.isArray(v) ? v : v.excerpts ?? [];
    return arr.filter((x) => x && typeof x.text === "string").map((x): SourceExcerpt => ({ speaker: x.speaker === "client" || x.speaker === "jordan" ? x.speaker : "third-party", speakerName: x.speakerName ?? null, source: x.source ?? "call", text: x.text.slice(0, 1200) })).slice(0, 12);
  } catch { return []; }
}

export type GenerateScriptOpts = { topicId: string; monthId: string | null; requestedBy: string; unattended: boolean; callRecordId?: string | null; excerpts?: SourceExcerpt[]; selectedOnCall?: boolean };

/** Transcript / topic path: one script version (INTERNAL_REVIEW) for a topic, through the policy prompt + validator. */
export async function generateScriptForTopic(o: GenerateScriptOpts): Promise<{ scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number }> {
  const { topic, row } = await policyTopic(o.topicId);
  const built = await buildClientContext(row.enrollmentId, { monthId: o.monthId });
  const excerpts = o.excerpts ?? (await excerptsForTopic(o.topicId, o.monthId));
  const scrub = await scrubOtherClients(row.clientId, excerpts.map((e) => e.text));
  const bundle = buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: excerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: o.selectedOnCall ?? true });
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: row.enrollmentId, clientId: row.clientId, scope: { topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, excerpts: excerpts.length },
    promptKey: "script", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: `script:${o.topicId}:${o.monthId ?? "bank"}`, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000,
  });
  const { parts, validation, gaps } = partsFromGenerated(run.output, row.pillarId ?? (await resolvePillarByLabel(row.enrollmentId, run.output.category)), row.clientId);
  if (!parts.title) parts.title = row.title;
  // monthId null = the bank-level script (IS NULL), never "any month's script".
  const existing = await prisma.contentScript.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, historical: false }, select: { id: true } });
  const r = await createScriptVersion({
    scriptId: existing?.id ?? null, enrollmentId: row.enrollmentId, monthId: o.monthId, topicId: o.topicId, parts, source: "AI", createdBy: o.requestedBy, status: "INTERNAL_REVIEW",
    callRecordId: o.callRecordId ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId, validation: { ok: validation.ok, findings: validation.findings }, gaps,
    changeSummary: `Drafted from the ${excerpts.length ? "call excerpts" : "topic"} (${validation.ok ? "passes the format check" : `${validation.findings.filter((f) => f.severity === "block").length} blocking finding(s)`}; ${gaps.length} gap(s))`,
  });
  await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
  await prisma.contentTopic.updateMany({ where: { id: o.topicId, status: "SELECTED" }, data: { status: "SCRIPTED" } });
  await recordTopicEvent(o.topicId, row.enrollmentId, "SCRIPTED", { kind: "AI" }, { monthId: o.monthId, sourceRef: `ContentScriptVersion:${r.versionId}` });
  return { scriptId: r.scriptId, versionId: r.versionId, versionNo: r.versionNo, ok: validation.ok, findings: validation.findings.length, gaps: gaps.length };
}

/** Written-answer path: a DRAFT version from the interview's exact answer rows, gaps carried through, never filled. */
export async function generateScriptFromInterview(interviewId: string, requestedBy: string, opts: { unattended?: boolean } = {}): Promise<{ scriptId: string; versionId: string; ok: boolean; gaps: number }> {
  const a = await assembleInterviewInputs(interviewId);
  const built = await buildClientContext(a.enrollmentId, { monthId: a.monthId });
  const bundle = buildScriptPrompt(built.ctx, { path: "written-answers", input: a.input });
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: a.enrollmentId, clientId: a.clientId, scope: { interviewId, topicId: a.topic.id, monthId: a.monthId }, inputRefs: { ...built.inputRefs, answerIds: a.answerIds },
    promptKey: "script", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: opts.unattended ?? false, dedupeKey: `script:interview:${interviewId}`,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000,
  });
  const { parts, validation, gaps } = partsFromGenerated(run.output, a.topic.pillarRef.pillarId, a.clientId);
  if (!parts.title) parts.title = a.topic.title;
  const existing = await prisma.contentScript.findFirst({ where: { interviewId }, select: { id: true, currentVersionId: true } });
  const r = await createScriptVersion({
    scriptId: existing?.id ?? null, enrollmentId: a.enrollmentId, monthId: a.monthId, topicId: a.topic.id, parts, source: "AI", createdBy: requestedBy, status: "DRAFT",
    basedOnVersionId: existing?.currentVersionId ?? null, interviewId, answerIds: a.answerIds, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId,
    validation: { ok: validation.ok, findings: validation.findings }, gaps: [...a.input.gaps, ...gaps],
    changeSummary: existing ? "New draft from the changed answers — the earlier version is kept." : `Drafted from ${a.input.completeness.substantiveAnswered}/${a.input.completeness.substantiveTotal} substantive answers`,
  });
  await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
  await prisma.contentTopic.updateMany({ where: { id: a.topic.id!, status: "SELECTED" }, data: { status: "SCRIPTED" } });
  return { scriptId: r.scriptId, versionId: r.versionId, ok: validation.ok, gaps: a.input.gaps.length + gaps.length };
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
  const topic = s.topicId ? (await policyTopic(s.topicId)).topic : makeTopic({ title: s.title, pillarName: base.categoryLabel ?? "(no pillar)", clientId: s.clientId });
  // Same other-client scrub as the first draft — a call excerpt naming another enrolled client never reaches a revision prompt either.
  const rawExcerpts = s.topicId ? await excerptsForTopic(s.topicId, s.monthId) : [];
  const scrub = await scrubOtherClients(s.clientId, rawExcerpts.map((e) => e.text));
  const bundle = buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: rawExcerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: true });
  const user = `${bundle.user}\n\nCURRENT VERSION (v${base.versionNo}) — keep what already works, change only what the reviewer asks:\n${base.body}\n\nREVIEWER'S INSTRUCTION: ${instructions.trim().slice(0, 2000)}`;
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_revise", enrollmentId: s.enrollmentId, clientId: s.clientId, scope: { scriptId, basedOnVersionId: baseId }, inputRefs: { ...built.inputRefs, instruction: sha256(instructions) },
    promptKey: "script", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: false, dedupeKey: `revise:${scriptId}`,
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
  const existingRows = await prisma.contentTopic.findMany({ where: { enrollmentId: run.enrollmentId }, select: { title: true, status: true, pillarId: true, pillar: true, rejectionReason: true, archiveReason: true } });
  const nameOf = (id: string | null, label: string | null) => pillars.find((p) => p.id === id)?.name ?? label ?? "(no pillar)";
  const existing = existingRows.map((t) => ({ title: t.title, pillarName: nameOf(t.pillarId, t.pillar), state: (t.status === "REJECTED" || t.status === "ARCHIVED" ? "ARCHIVED" : t.status === "SELECTED" || t.status === "SCRIPTED" ? "SELECTED" : ["FILMED", "DELIVERED", "EDITING"].includes(t.status) ? "FILMED" : "SUGGESTED") as Topic["state"], note: t.rejectionReason ?? t.archiveReason ?? null }));
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
  facts: { body: string; category: FactCategory; fieldKey: string | null; scope: "PERMANENT" | "MONTH" | "PROJECT"; speaker: string | null; confidential: boolean; confidence: number; excerpt: Excerpt | null }[];
  strategyProposals: { kind: "STRATEGY" | "PILLAR" | "AUDIENCE" | "POSITIONING" | "PREFERENCE"; summary: string; impact: string | null }[];
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
    facts: { type: "array", items: { type: "object", required: ["body", "category", "scope", "confidential", "confidence"], properties: { body: { type: "string" }, category: { type: "string", enum: ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "PERFORMANCE_REPORTED", "DECISION", "COMMITMENT", "FEEDBACK", "PROPOSED_CHANGE"] }, fieldKey: { type: ["string", "null"], description: "e.g. production.location_preference, editing.pace, brand.voice — or null" }, scope: { type: "string", enum: ["PERMANENT", "MONTH", "PROJECT"] }, speaker: { type: ["string", "null"] }, confidential: { type: "boolean" }, confidence: { type: "number" }, excerpt: { anyOf: [EXCERPT_SCHEMA, { type: "null" }] } } } },
    strategyProposals: { type: "array", items: { type: "object", required: ["kind", "summary"], properties: { kind: { type: "string", enum: ["STRATEGY", "PILLAR", "AUDIENCE", "POSITIONING", "PREFERENCE"] }, summary: { type: "string" }, impact: { type: ["string", "null"] } } } },
    priorities: { type: "array", items: { type: "string" } },
    todos: { type: "array", items: { type: "string" } },
  },
};

const ANALYSIS_SYSTEM = (videosOwed: number, history: string) =>
  "You are processing a call transcript for a real-estate agent's monthly video program. FIRST judge what kind of call this is (planning / discovery / review / other). " +
  "If it is a planning session, set plannedMonthKey to the month the topics are FOR (a call in the last third of a month usually plans the NEXT month). Use the call date in the prompt.\n" +
  "Report what the CLIENT actually agreed to, not everything mentioned: selectedTopics need a client-spoken excerpt each; discussedTopics are ideas without agreement; rejectedIdeas were explicitly declined. " +
  "facts: NEW durable facts about the agent (preferences, decisions, commitments, reported results) — quote or closely paraphrase, with speaker and an excerpt; scope PROJECT for 'let's try X on this one', MONTH for this month only, PERMANENT otherwise; anything told in confidence or commercially sensitive is confidential=true. " +
  "strategyProposals: only when the client changes positioning, audience, pillars or a standing preference — a proposal for staff, never a rewrite. priorities: this month's campaign priorities in the client's words. todos: action items either side committed to.\n" +
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
  const run = await runAiJson<Analysis>({
    kind: "call_analysis", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { monthId: o.monthId, callRecordId: o.callRecordId ?? null, transcriptSourceId: o.transcriptSourceId ?? null }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript) },
    promptKey: "call-analysis", promptVersion: `${GENERATION_POLICY_VERSION}/analysis.2`, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: o.callRecordId ? `analyze:${o.callRecordId}` : `analyze:month:${o.monthId}`,
    system: ANALYSIS_SYSTEM(o.videosOwed, history),
    prompt: `CLIENT: ${built.ctx.clientName} (id ${o.clientId})\nCALL DATE: ${o.callDate ? o.callDate.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }) : `sometime in ${o.monthKey}`}\n\n${context}\n\n${facts.length ? `ACCEPTED FACTS ON FILE:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` : ""}TRANSCRIPT:\n${o.transcript.slice(0, 150_000)}`,
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
  let factsN = 0, confidentialN = 0;
  for (const f of Array.isArray(out.facts) ? out.facts : []) {
    if (!f.body?.trim()) continue;
    const r = await createFact({
      clientId: o.clientId, enrollmentId: o.enrollmentId, category: f.category, fieldKey: f.fieldKey ?? null, body: f.body, source: "call", sourceRef, callRecordId: o.callRecordId ?? null, transcriptSourceId: o.transcriptSourceId ?? null,
      excerpt: f.excerpt ? [{ time: f.excerpt.time ?? null, speaker: f.excerpt.speaker, text: f.excerpt.text }] : null, speaker: f.speaker ?? f.excerpt?.speaker ?? null, factDate: o.callDate ?? new Date(),
      scope: f.scope, monthId: f.scope === "MONTH" ? targetMonthId : null, confidential: f.confidential === true, confidence: typeof f.confidence === "number" ? f.confidence : null, aiRunId: run.runId, unattended: o.unattended,
    });
    if (!r.existed) { factsN++; if (f.confidential) confidentialN++; }
  }
  let proposals = 0;
  for (const p of Array.isArray(out.strategyProposals) ? out.strategyProposals : []) {
    if (!p.summary?.trim()) continue;
    await createStrategyProposal({ enrollmentId: o.enrollmentId, kind: p.kind, summary: p.summary, impact: p.impact ?? null, sourceKind: "call", sourceRef, callRecordId: o.callRecordId ?? null });
    proposals++;
  }
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

// --- the transcript-job handler registry (for W1-B's driver) ------------------------------------

export type TranscriptJobInput = { id: string; kind: string; callRecordId: string; transcriptSourceId?: string | null; enrollmentId?: string | null; requestedBy?: string | null; /** Refresh the driver's lease between long AI calls. */ heartbeat?: () => Promise<void> };
export type TranscriptJobOutcome = { ok: true; resultJson: Record<string, unknown>; aiRunId?: string | null } | { ok: false; reviewReason?: string; error?: string; aiRunId?: string | null };

async function callAndTranscript(job: TranscriptJobInput) {
  const call = await prisma.programCallRecord.findUnique({ where: { id: job.callRecordId } });
  if (!call) return { error: "Call record not found." } as const;
  if (!call.enrollmentId || !call.clientId) return { reviewReason: "The call is not matched to a client yet — confirm the invitee first." } as const;
  // CONFIRMED sources on this call only — never a candidate copy, never ContentMonth.transcriptText.
  const sources = job.transcriptSourceId
    ? await prisma.programTranscriptSource.findMany({ where: { id: job.transcriptSourceId, callRecordId: call.id, matchState: "CONFIRMED" } })
    : await prisma.programTranscriptSource.findMany({ where: { callRecordId: call.id, matchState: "CONFIRMED", text: { not: null } }, orderBy: { version: "desc" } });
  const text = sources.map((s) => s.text ?? "").filter(Boolean).join("\n\n----\n\n");
  if (!text.trim()) return { reviewReason: "No confirmed transcript text on this call." } as const;
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: call.enrollmentId }, select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true } });
  if (!enrollment) return { error: "Enrollment not found." } as const;
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
    const { call, text, enrollment, month, sourceId } = ct;
    const beat = async () => { if (job.heartbeat) await job.heartbeat().catch(() => {}); };
    await beat();
    switch (job.kind) {
      case "ANALYZE":
      case "FACT_EXTRACT": {
        const r = await analyzeTranscriptText({ enrollmentId: enrollment.id, clientId: enrollment.clientId, monthId: month.id, monthKey: month.monthKey, transcript: text, callDate: call.scheduledStart, videosOwed: month.videosOwed, requestedBy, unattended, callRecordId: call.id, transcriptSourceId: sourceId });
        await prisma.programCallRecord.update({ where: { id: call.id }, data: { analysisRunId: r.runId, transcriptState: "ANALYZED", analysisJson: JSON.stringify(r) } }).catch(() => {});
        return { ok: true, resultJson: { ...r }, aiRunId: r.runId };
      }
      case "STRATEGY_DRAFT": {
        if (call.callType !== "BRAND_DISCOVERY") return { ok: false, reviewReason: "A strategy is drafted from a brand-discovery call only; this call is " + call.callType.toLowerCase() + "." };
        const r = await draftStrategyFromTranscript({ enrollmentId: enrollment.id, clientId: enrollment.clientId, transcript: text, callRecordId: call.id, requestedBy, unattended });
        return { ok: true, resultJson: { strategyVersionId: r.versionId, versionNo: r.versionNo, gaps: r.gaps }, aiRunId: r.runId };
      }
      case "SCRIPT_DRAFT": {
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
    if (e instanceof Error && e.name === "AutomationDisabledError") return { ok: false, reviewReason: msg };
    return { ok: false, error: msg };
  }
}

/** Discovery call → a DRAFT strategy version in the house template, with gaps instead of inventions. Jordan approves. */
export async function draftStrategyFromTranscript(o: { enrollmentId: string; clientId: string; transcript: string; callRecordId?: string | null; intakeText?: string | null; requestedBy: string; unattended: boolean }): Promise<{ versionId: string; versionNo: number; gaps: number; runId: string }> {
  const built = await buildClientContext(o.enrollmentId);
  const excerptCtx: ClientContext = { ...built.ctx, sourceExcerpts: [{ speaker: "client", speakerName: built.ctx.clientName, source: "discovery-call transcript (speaker turns not separated — treat lines as the client's only where the transcript says so)", text: o.transcript.slice(0, 120_000) }] };
  const bundle = buildStrategyPrompt(excerptCtx, { intakeText: o.intakeText ?? null, priorStrategyNote: built.ctx.strategy ? `An approved strategy (${built.strategyLabel}) exists; this draft is a proposed new version, not a replacement.` : null });
  type StrategyOut = { clientName: string; subtitle: string; brandOverview: { coreValues: string; brandMessage: string; shortBrandStatement: string | null; brandVoice: string }; targetAudience: { primaryServiceAreas: string; pricePositioning: string | null; primaryClientTypes: string; longTermPositioningGoal: string }; contentGoals: string[]; contentPillars: { preamble: string; pillars: { name: string; purpose: string; focusAreas: string; contentApproach: string | null }[] }; framework: string; captionCtaExamples: string[]; strategicDirection: string; gaps: Gap[] };
  const run = await runAiJson<StrategyOut>({ kind: "strategy_draft", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript) }, promptKey: "strategy", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: o.callRecordId ? `strategy:${o.callRecordId}` : null, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 12_000 });
  const out = run.output;
  const doc: StrategyDocument = {
    clientName: out.clientName || built.ctx.clientName, year: new Date().getUTCFullYear(), subtitle: out.subtitle,
    brandOverview: { coreValues: out.brandOverview.coreValues, brandMessage: out.brandOverview.brandMessage, shortBrandStatement: out.brandOverview.shortBrandStatement, brandVoice: out.brandOverview.brandVoice, otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: out.targetAudience.primaryServiceAreas, pricePositioning: out.targetAudience.pricePositioning, primaryClientTypes: out.targetAudience.primaryClientTypes, longTermPositioningGoal: out.targetAudience.longTermPositioningGoal, otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: out.contentGoals, numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: [out.contentPillars.preamble], pillars: out.contentPillars.pillars.map((p, i) => ({ number: i + 1, name: p.name, heading: `Pillar ${i + 1}: ${p.name}`, purpose: p.purpose, focusAreas: p.focusAreas, contentApproach: p.contentApproach, otherFields: [] })) },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: out.captionCtaExamples }, strategicDirection: { heading: "Strategic Direction", paragraphs: [out.strategicDirection] }, otherSections: [],
  };
  const text = renderStrategy(doc);
  const { stored } = structuredFromText(text);
  const gaps = Array.isArray(out.gaps) ? out.gaps : [];
  if (gaps.length) stored.sections.push({ id: "gaps", number: null, heading: "Gaps the draft could not fill (from the call)", order: stored.sections.length + 1, text: gaps.map((g) => `• [${g.kind}${g.field ? ` · ${g.field}` : ""}] ${g.text}${g.question ? ` → ${g.question}` : ""}`).join("\n") });
  const r = await createStrategyVersion({ enrollmentId: o.enrollmentId, stored, rawText: text, sourceKind: "discovery_call", sourceRef: o.callRecordId ?? "discovery transcript", callRecordId: o.callRecordId ?? null, aiRunId: run.runId, policyVersionId: built.policyVersionId, basedOnVersionId: built.strategyVersionId, createdBy: "ai", status: "DRAFT", changeSummary: `AI draft from the discovery call (${gaps.length} gap${gaps.length === 1 ? "" : "s"} listed, not filled)` });
  await setRunOutputRef(run.runId, `ContentStrategyVersion:${r.versionId}`);
  return { versionId: r.versionId, versionNo: r.versionNo, gaps: gaps.length, runId: run.runId };
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

export const GENERATION_KINDS: AiRunKind[] = ["call_analysis", "strategy_draft", "topic_bank", "topic_refresh", "recommendation", "script_draft", "script_revise", "interview_plan"];
