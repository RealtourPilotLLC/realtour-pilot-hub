import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { runAiJson, activePolicyVersion, setRunOutputRef, releaseRunKey, claimRunWrite, sha256, type AiRunKind, type ClaimedRun } from "@/lib/aiRuns";
import { timeoutBefore } from "@/lib/integrations/ai";
import { approvedStrategy, createStrategyVersion, setMonthPriorities, monthPriorities, structuredFromText, parseStoredSections, deriveStrategyVersion } from "@/lib/contentStrategy";
import { listPillars, resolvePillarByLabel } from "@/lib/contentPillars";
import { createTopic, selectTopicForMonth, recordTopicEvent, blockedTopicHashes, pendingSuggestionHashes, finishRefreshRun, topicDedupeHash, type Actor } from "@/lib/contentTopics";
import { assembleInterviewInputs } from "@/lib/contentInterview";
import { createScriptVersion, ensureScriptVersioned, pointsFromJson, pillarNameOf, type VersionParts } from "@/lib/contentScripts";
import { factsForPrompt, factLines, confidentialFilter, CONFIDENTIAL_RE, CONFIDENTIAL_PHRASE_RE, type FactCategory } from "@/lib/clientFacts";
import { CONTENT_RULES } from "@/lib/contentPipeline";
import { pendingJudge } from "@/lib/scriptJudgeRecord";
import {
  buildScriptPrompt, buildTopicBankPrompt, buildStrategyPrompt, buildStrategyRevisionPrompt, scriptFromGeneratorOutput, validateNewScript, validateTopicBank, renderStrategy, policyFrameworkSection, isFrameworkSection, canonicalFrameworkSectionText,
  GENERATION_POLICY, GENERATION_POLICY_VERSION, SPEAKER_ATTRIBUTION_RULE, NO_INVENTION_RULE, makeTopic, normalizeTitle, policyStamp, videoStyleFromOverrides, titleSimilarity, NEAR_DUPLICATE_THRESHOLD,
  creativeIdentityFromOverrides, buildScriptRevisePrompt, formulaicTitleShape, asLockSections, ANGLE_FIELDS, LOCKABLE_SECTION_LABEL,
  type ClientContext, type SourceExcerpt, type GeneratedScriptJson, type Topic, type TopicBank, type Gap, type StrategyDocument, type ScriptPromptSource, type LockableSection, type ScriptAngle,
} from "@/lib/contentPolicy";
import { creativeGuardFromOverrides, discontinuedHit } from "@/lib/creativeGuardCore";

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

type VoiceCandidate = { id: string; title: string; body: string; monthId: string | null; kind: "approved" | "manual" | "import" };

/**
 * VOICE REFERENCES (Oct 14 2026). Only the three newest IMPORTED scripts were
 * passed, so a client whose archive was never imported (five of them) had no
 * voice reference at all, and the scripts Jordan approved or uploaded himself
 * were never read. Now: this client's newest hub-approved scripts and MANUAL
 * versions (uploads and hand edits) first, then imports. The caller takes at
 * most three, each scrubbed exactly as before.
 */
async function voiceReferenceCandidates(enrollmentId: string, opts: { take: number; excludeScriptId?: string | null }): Promise<VoiceCandidate[]> {
  const notThis = opts.excludeScriptId ? { id: { not: opts.excludeScriptId } } : {};
  const [approved, manual, imports] = await Promise.all([
    prisma.contentScript.findMany({ where: { enrollmentId, historical: false, approvedVersionId: { not: null }, ...notThis }, orderBy: { createdAt: "desc" }, take: opts.take * 3, select: { id: true, title: true, monthId: true, approvedVersionId: true, approvedAt: true, createdAt: true } }),
    prisma.contentScriptVersion.findMany({ where: { enrollmentId, source: "MANUAL", ...(opts.excludeScriptId ? { scriptId: { not: opts.excludeScriptId } } : {}) }, orderBy: { createdAt: "desc" }, take: opts.take * 3, select: { scriptId: true, title: true, body: true, createdAt: true } }),
    prisma.contentScript.findMany({ where: { enrollmentId, source: "import", ...notThis }, orderBy: { createdAt: "desc" }, take: opts.take * 3, select: { id: true, title: true, body: true, monthId: true } }),
  ]);
  const approvedBodies = approved.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: approved.map((a) => a.approvedVersionId!) } }, select: { id: true, body: true } }) : [];
  const monthOf = new Map((manual.length ? await prisma.contentScript.findMany({ where: { id: { in: manual.map((m) => m.scriptId) } }, select: { id: true, monthId: true } }) : []).map((s) => [s.id, s.monthId]));
  const first = [
    ...approved.map((a) => ({ id: a.id, title: a.title, body: approvedBodies.find((v) => v.id === a.approvedVersionId)?.body ?? "", monthId: a.monthId, kind: "approved" as const, at: (a.approvedAt ?? a.createdAt).getTime() })),
    ...manual.map((m) => ({ id: m.scriptId, title: m.title, body: m.body, monthId: monthOf.get(m.scriptId) ?? null, kind: "manual" as const, at: m.createdAt.getTime() })),
  ].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: VoiceCandidate[] = [];
  for (const r of [...first, ...imports.map((i) => ({ ...i, kind: "import" as const }))]) {
    if (seen.has(r.id) || !r.body.trim()) continue;
    seen.add(r.id);
    out.push({ id: r.id, title: r.title, body: r.body, monthId: r.monthId, kind: r.kind });
  }
  return out;
}

export async function buildClientContext(enrollmentId: string, opts: { monthId?: string | null; monthKey?: string | null; projectId?: string | null; priorScripts?: number; /** A revision does not read its own script as a voice reference. */ excludeScriptId?: string | null } = {}): Promise<BuiltContext> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
  if (!e) throw new Error("Enrollment not found.");
  const take = opts.priorScripts ?? 3;
  const [client, strategy, policy, facts, candidates, month] = await Promise.all([
    prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }),
    approvedStrategy(enrollmentId),
    activePolicyVersion(),
    factsForPrompt(e.clientId, { monthId: opts.monthId ?? null, projectId: opts.projectId ?? null }),
    voiceReferenceCandidates(enrollmentId, { take, excludeScriptId: opts.excludeScriptId ?? null }),
    opts.monthId ? prisma.contentMonth.findUnique({ where: { id: opts.monthId }, select: { prioritiesJson: true } }) : Promise.resolve(null),
  ]);
  const monthKeys = new Map((await prisma.contentMonth.findMany({ where: { enrollmentId }, select: { id: true, monthKey: true } })).map((m) => [m.id, m.monthKey]));
  const explicit = factLines(facts.filter((f) => f.category === "BRAND_PREFERENCE" || f.category === "PRODUCTION_PREFERENCE" || f.category === "DECISION"));
  const known = factLines(facts.filter((f) => !["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "DECISION", "INTERNAL"].includes(f.category)));
  const [expl, kn] = await Promise.all([scrubOtherClients(e.clientId, explicit), scrubOtherClients(e.clientId, known)]);
  const priorScripts: ClientContext["priorScripts"] = [];
  const prior: VoiceCandidate[] = [];
  let strippedScripts = 0;
  for (const s of candidates) {
    if (prior.length >= take) break;
    // A prior script that names another client (a referral story) is dropped whole.
    const r = await scrubOtherClients(e.clientId, [s.body]);
    if (r.stripped) { strippedScripts++; continue; }
    if (CONFIDENTIAL_RE.test(s.body)) { strippedScripts++; continue; }
    prior.push(s);
    priorScripts.push({ title: s.title, text: s.body.slice(0, 2500), monthKey: s.monthId ? monthKeys.get(s.monthId) ?? null : null });
  }
  // Oct 14 2026: this month's priorities (the call's, or typed by staff), scrubbed like the facts.
  const priorities = month ? (await scrubOtherClients(e.clientId, monthPriorities(month.prioritiesJson))).kept.filter((p) => !CONFIDENTIAL_RE.test(p)) : [];
  const ctx: ClientContext = {
    clientId: e.clientId, clientName: client?.name ?? "Client",
    strategy: strategy ? { version: strategy.label, document: strategy.document } : null,
    preferences: { explicit: expl.kept, inferred: [] },
    knownFacts: kn.kept,
    priorScripts,
    monthKey: opts.monthKey ?? (opts.monthId ? monthKeys.get(opts.monthId) ?? null : null),
    // Oct 13 2026: Direct-to-camera or Skits (Settings › Program style). Every
    // script and topic prompt built from this context reads it.
    videoStyle: videoStyleFromOverrides(e.overridesJson),
    // Oct 14 2026: the auto-built creative identity (creativeIdentity.ts) and this month's priorities.
    creativeIdentity: creativeIdentityFromOverrides(e.overridesJson),
    monthPriorities: priorities,
    // Oct 15 2026: proven format, discontinued series, experiment limit (creativeGuardCore.ts).
    creativeGuard: creativeGuardFromOverrides(e.overridesJson),
  };
  return {
    ctx, enrollmentId, clientId: e.clientId, strategyVersionId: strategy?.versionId ?? null, strategyLabel: strategy?.label ?? null, policyVersionId: policy.id,
    inputRefs: { strategyVersionId: strategy?.versionId ?? null, factIds: facts.map((f) => f.id), priorScriptIds: prior.map((p) => p.id), voiceKinds: prior.map((p) => p.kind), strippedLines: expl.stripped + kn.stripped + strippedScripts, policyHash: policyStamp(null).policyHash },
  };
}

// --- scripts ----------------------------------------------------------------------

/** The writer's angle from a model answer (Oct 14 2026): the six fields, trimmed, or null when it sent none. */
function cleanAngle(a: unknown): ScriptAngle | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  const out = {} as ScriptAngle;
  let any = false;
  for (const k of ANGLE_FIELDS) {
    const v = typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim().slice(0, 400) : "";
    out[k] = v;
    if (v) any = true;
  }
  return any ? out : null;
}

/**
 * Oct 13 2026: a SKIT (a SKITS account's draft, or a revision of a skit) keeps
 * its lines, one per line, and its speaker labels: a scene flattened into one
 * paragraph would lose who says what, and the labels are what keep the
 * directions and the speakers out of the spoken-word count. A direct-to-camera
 * draft is stored exactly as before. Oct 14 2026: the writer's angle comes back
 * too (stored in validationJson, staff only).
 */
function partsFromGenerated(json: GeneratedScriptJson, pillarId: string | null, clientId: string | null = null, opts: { skit?: boolean } = {}): { parts: VersionParts; validation: ReturnType<typeof validateNewScript>; gaps: Gap[]; angle: ScriptAngle | null } {
  const script = scriptFromGeneratorOutput(json, policyStamp(null), clientId, { skit: !!opts.skit });
  const validation = validateNewScript(script);
  const said = (b: { text: string; lines: string[] } | null | undefined) => (b ? (opts.skit ? b.lines.join("\n") : b.text) : "");
  const parts: VersionParts = {
    title: script.title, categoryLabel: script.pillarRef?.categoryAsDelivered ?? json.category ?? null, pillarId,
    hook: said(script.hook), points: script.points.map((p) => ({ role: p.role, text: said(p) })), close: said(script.close), captionCta: script.captionCta,
    filmingNotes: script.internal.filmingNotes, sourceExcerpts: script.internal.sourceExcerpts, dimensionsCheck: (script.internal.contentPillarCheck as Record<string, string> | null) ?? null, placeholders: script.internal.placeholders,
    ...(opts.skit && script.internal.speakerLabels.length ? { speakerLabels: script.internal.speakerLabels } : {}),
  };
  return { parts, validation, gaps: validation.gaps, angle: cleanAngle(json.angle) };
}

/** A new AI draft's validation record: the format check, the angle, and a judge still owed (scriptJudge.ts). */
function draftValidation(validation: ReturnType<typeof validateNewScript>, angle: ScriptAngle | null, fixRounds = 0) {
  return { ok: validation.ok, findings: validation.findings, angle, judge: pendingJudge(fixRounds) };
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

/**
 * THE CLIENT'S OWN LINES (Oct 14 2026). The call analysis keeps, per selected
 * topic, the client's sharpest lines verbatim (ANALYSIS_SCHEMA quotableLines,
 * stored beside the excerpts in the selection's evidence). Read like the
 * excerpts: this month's selection first, then any; scrubbed of anything
 * confidential or naming another client.
 */
export async function quotableLinesForTopic(topicId: string, monthId: string | null, clientId: string): Promise<string[]> {
  const HAS = { contains: '"quotableLines"' };
  const row =
    (monthId ? await prisma.contentTopicSelection.findFirst({ where: { topicId, monthId, evidenceJson: HAS }, select: { evidenceJson: true } }) : null)
    ?? (await prisma.contentTopicSelection.findFirst({ where: { topicId, evidenceJson: HAS }, orderBy: { createdAt: "desc" }, select: { evidenceJson: true } }))
    ?? (await prisma.contentTopicEvent.findFirst({ where: { topicId, evidenceJson: HAS }, orderBy: { createdAt: "desc" }, select: { evidenceJson: true } }));
  if (!row?.evidenceJson) return [];
  let lines: string[] = [];
  try {
    const v = JSON.parse(row.evidenceJson) as { quotableLines?: unknown };
    lines = Array.isArray(v.quotableLines) ? v.quotableLines.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 300)) : [];
  } catch { return []; }
  if (!lines.length) return [];
  const secret = await confidentialFilter(clientId);
  const cleared = lines.filter((l) => !CONFIDENTIAL_RE.test(l) && !CONFIDENTIAL_PHRASE_RE.test(l) && !secret(l));
  return (await scrubOtherClients(clientId, cleared)).kept.slice(0, 6);
}

/**
 * THE SOURCE A SCRIPT WAS WRITTEN FROM (Oct 14 2026). reviseScript always
 * rebuilt its prompt on the transcript path with "SELECTED ON THE CALL: yes",
 * so a script drafted from the client's WRITTEN answers lost those answers on
 * every revision. The same choice the drafting sweep makes: the written
 * answers when the script (or its topic this month) has a submitted
 * interview, else the call excerpts. The revision and the judge both read it.
 */
export async function scriptSourceFor(
  s: { id: string; topicId: string | null; monthId: string | null; clientId: string; interviewId: string | null; title: string },
  base: { categoryLabel: string | null },
): Promise<{ source: ScriptPromptSource; interviewId: string | null }> {
  let interviewId = s.interviewId;
  if (!interviewId && s.topicId && s.monthId) {
    const iv = await prisma.contentInterview.findFirst({
      where: { topicId: s.topicId, monthId: s.monthId, clientId: s.clientId, OR: [{ submittedAt: { not: null } }, { sentWithGapsAt: { not: null } }, { status: "SUBMITTED" }] },
      orderBy: { updatedAt: "desc" }, select: { id: true },
    });
    interviewId = iv?.id ?? null;
  }
  const quotableLines = s.topicId ? await quotableLinesForTopic(s.topicId, s.monthId, s.clientId).catch(() => []) : [];
  if (interviewId) {
    const a = await assembleInterviewInputs(interviewId).catch(() => null);
    if (a && a.clientId === s.clientId) return { source: { path: "written-answers", input: a.input, excerpts: a.excerpts, quotableLines }, interviewId };
  }
  const topic = s.topicId ? (await policyTopic(s.topicId)).topic : makeTopic({ title: s.title, pillarName: base.categoryLabel ?? "", clientId: s.clientId });
  // Same other-client scrub as the first draft — a call excerpt naming another enrolled client never reaches a revision prompt either.
  const rawExcerpts = s.topicId ? await excerptsForTopic(s.topicId, s.monthId) : [];
  const scrub = await scrubOtherClients(s.clientId, rawExcerpts.map((e) => e.text));
  return { source: { path: "transcript", topic, excerpts: rawExcerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: true, quotableLines }, interviewId: null };
}

/** After every AI draft (Oct 14 2026): the automatic judge and up to two fix rounds. Never throws; a failure leaves the draft as written. */
async function checkDraft(scriptId: string, o: { requestedBy: string; unattended: boolean; deadline?: number | null }): Promise<void> {
  try {
    const { autoCheckScript } = await import("@/lib/scriptJudge");
    await autoCheckScript(scriptId, o);
  } catch (e) {
    console.warn(`[script judge] ${scriptId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * CP-08: the script prompt with the per-part word budgets — every script draft
 * names it, so a before/after on estimated length is attributable. v3 (Oct 6
 * 2026): the budgets rescaled for the 30–50 s target. v4 (Oct 12 2026): no
 * dashes in a script (the punctuation rule in the prompt, and a revision is
 * told to take out any the current version has). v5 (Oct 14 2026): the clean
 * house brief, the angle first, audience psychology, section rules, creative
 * identity, the client's own lines.
 */
const SCRIPT_PROMPT_VERSION = "script.v5-angle";
/** Oct 13 2026: a SKITS account's prompt carries the skit block, so its runs say so. */
const scriptPromptVersion = (ctx: ClientContext) => (ctx.videoStyle === "SKITS" ? `${SCRIPT_PROMPT_VERSION}+skits` : SCRIPT_PROMPT_VERSION);

export type GenerateScriptOpts = {
  topicId: string; monthId: string | null; requestedBy: string; unattended: boolean; callRecordId?: string | null; excerpts?: SourceExcerpt[]; selectedOnCall?: boolean;
  /** The "draft what's owed" sweep: never add a version to a script that exists — see AlreadyDraftedError. */
  onlyIfUnscripted?: boolean;
  /** Oct 12 2026: the queued run a background worker claimed for this draft (aiQueue.ts) — adopted, not duplicated. */
  claimedRun?: ClaimedRun | null;
  /** Oct 14 2026: the time (ms epoch) the automatic check must not start a model call past; what is left is finished by the AI cron. */
  checkDeadline?: number | null;
  /** Oct 21 2026 (audit H1): a sweep's clock (ms epoch); the draft's own model call ends by it. */
  deadline?: number | null;
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

/** Refused in words when a topic names a series the client stopped (Oct 15 2026). */
export class DiscontinuedSeriesError extends Error {
  constructor(title: string, series: string) { super(`"${title}" is part of "${series}", which this client stopped. Pick another topic.`); this.name = "DiscontinuedSeriesError"; }
}
function assertNotDiscontinued(text: string, ctx: ClientContext, title: string): void {
  const hit = discontinuedHit(text, ctx.creativeGuard);
  if (hit) throw new DiscontinuedSeriesError(title, hit);
}

/** Transcript / topic path: one script version (INTERNAL_REVIEW) for a topic, through the policy prompt + validator. */
export async function generateScriptForTopic(o: GenerateScriptOpts): Promise<{ scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number }> {
  const { topic, row } = await policyTopic(o.topicId);
  await (await import("@/lib/programStyle")).assertWeWriteFor(row.enrollmentId); // Oct 8 2026: client-planned → no scripts from us
  const built = await buildClientContext(row.enrollmentId, { monthId: o.monthId });
  // Oct 15 2026: a topic that names a series this client stopped is refused
  // before any model call (creativeGuardCore.discontinuedHit).
  assertNotDiscontinued(`${row.title} ${row.concept ?? ""}`, built.ctx, row.title);
  // Oct 22 2026: the new writer (src/lib/scriptWriter), when its switch is on
  // for this client. A skit account stays on this writer.
  if (built.ctx.videoStyle !== "SKITS" && (await (await import("@/lib/scriptWriter/pipeline")).writerOnFor(row.enrollmentId))) {
    const r = await generateWithWriter({
      topicId: o.topicId, monthId: o.monthId, pillarId: row.pillarId, enrollmentId: row.enrollmentId, clientId: row.clientId, title: row.title, requestedBy: o.requestedBy, unattended: o.unattended,
      callRecordId: o.callRecordId ?? null, interviewId: null, onlyIfUnscripted: !!o.onlyIfUnscripted, claimedRun: o.claimedRun ?? null, checkDeadline: o.checkDeadline ?? null, deadline: o.deadline ?? null,
    });
    return { scriptId: r.scriptId, versionId: r.versionId, versionNo: r.versionNo, ok: r.ok, findings: r.findings, gaps: r.gaps };
  }
  const excerpts = o.excerpts ?? (await excerptsForTopic(o.topicId, o.monthId));
  const scrub = await scrubOtherClients(row.clientId, excerpts.map((e) => e.text));
  const quotableLines = await quotableLinesForTopic(o.topicId, o.monthId, row.clientId).catch(() => []);
  const bundle = buildScriptPrompt(built.ctx, { path: "transcript", topic, excerpts: excerpts.filter((e) => scrub.kept.includes(e.text)), selectedOnCall: o.selectedOnCall ?? true, quotableLines });
  if (o.onlyIfUnscripted) await assertUnscripted(o.topicId, o.monthId, null, `"${row.title}"`);
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: row.enrollmentId, clientId: row.clientId, scope: { topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, excerpts: excerpts.length, quotableLines: quotableLines.length },
    promptKey: "script", promptVersion: scriptPromptVersion(built.ctx), policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended,
    dedupeKey: `script:${o.topicId}:${o.monthId ?? "bank"}`, holdDedupeKey: true, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000, claimedRun: o.claimedRun ?? null,
    timeoutMs: timeoutBefore(o.deadline, 3000),
  });
  let out: { scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number };
  try {
    const { parts, validation, gaps, angle } = partsFromGenerated(run.output, row.pillarId ?? (await resolvePillarByLabel(row.enrollmentId, run.output.category)), row.clientId, { skit: built.ctx.videoStyle === "SKITS" });
    if (!parts.title) parts.title = row.title;
    // monthId null = the bank-level script (IS NULL), never "any month's script".
    const existing = await prisma.contentScript.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, historical: false }, select: { id: true } });
    if (existing && o.onlyIfUnscripted) throw new AlreadyDraftedError(`"${row.title}"`);
    // Still this run's to write? A caller that froze past its lease may have
    // been replaced by one that drafted this very script (claimRunWrite).
    await claimRunWrite(run.runId);
    const r = await createScriptVersion({
      scriptId: existing?.id ?? null, enrollmentId: row.enrollmentId, monthId: o.monthId, topicId: o.topicId, parts, source: "AI", createdBy: o.requestedBy, status: "INTERNAL_REVIEW",
      callRecordId: o.callRecordId ?? null, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId, validation: draftValidation(validation, angle), gaps,
      changeSummary: `Drafted from the ${excerpts.length ? "call excerpts" : "topic"} (${validation.ok ? "passes the format check" : `${validation.findings.filter((f) => f.severity === "block").length} blocking finding(s)`}; ${gaps.length} gap(s))`,
    });
    await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
    await releaseRunKey(run.runId);
    await prisma.contentTopic.updateMany({ where: { id: o.topicId, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    await recordTopicEvent(o.topicId, row.enrollmentId, "SCRIPTED", { kind: "AI" }, { monthId: o.monthId, sourceRef: `ContentScriptVersion:${r.versionId}` });
    out = { scriptId: r.scriptId, versionId: r.versionId, versionNo: r.versionNo, ok: validation.ok, findings: validation.findings.length, gaps: gaps.length };
  } finally {
    await releaseRunKey(run.runId); // idempotent; frees the key if the write above threw
  }
  // Oct 14 2026: judged, and fixed when it fails (two rounds at most). The draft is written already; nothing here can lose it.
  await checkDraft(out.scriptId, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.checkDeadline ?? null });
  return out;
}

/**
 * THE NEW WRITER'S DRAFT (Oct 22 2026, src/lib/scriptWriter). The same claims,
 * fences and writes as the two paths around it (onlyIfUnscripted, the held
 * dedupe key, claimRunWrite, one script per video), with the writer's steps in
 * front: the call passages, the topic brief and five scored hooks, then the
 * draft from the brief with the winning hook. The version carries the brief
 * (validationJson.writer) and a review owed (judge.writer = 2), which the
 * automatic check runs: the 12 checks, up to two fix rounds, one trim pass.
 */
async function generateWithWriter(o: {
  topicId: string; monthId: string | null; pillarId: string | null; enrollmentId: string; clientId: string; title: string; requestedBy: string; unattended: boolean;
  callRecordId: string | null; interviewId: string | null; answerIds?: string[] | null; interviewGaps?: Gap[]; onlyIfUnscripted: boolean; claimedRun: ClaimedRun | null; checkDeadline: number | null; deadline: number | null;
}): Promise<{ scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number }> {
  const w = await import("@/lib/scriptWriter/pipeline");
  const what = `"${o.title}"`;
  if (o.onlyIfUnscripted) await assertUnscripted(o.topicId, o.monthId, o.interviewId, what);
  const p = await w.prepareDraft({ topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId, interviewId: o.interviewId, requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline });
  // The steps before the draft take minutes: look again before the paid draft.
  if (o.onlyIfUnscripted) await assertUnscripted(o.topicId, o.monthId, o.interviewId, what);
  const dedupeKey = o.interviewId ? `script:interview:${o.interviewId}` : `script:${o.topicId}:${o.monthId ?? "bank"}`;
  const run = await w.runDraftStep(p, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline, claimedRun: o.claimedRun, dedupeKey, scope: { topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId, interviewId: o.interviewId } });
  let out: { scriptId: string; versionId: string; versionNo: number; ok: boolean; findings: number; gaps: number };
  try {
    const chosen = p.chosen >= 0 ? p.hooks[p.chosen] : null;
    const json = w.generatedFromDraft(run.output, chosen?.text ?? null, p.g.ctx.topic.pillar);
    const { parts, validation, gaps } = partsFromGenerated(json, o.pillarId ?? (await resolvePillarByLabel(o.enrollmentId, json.category)), o.clientId);
    if (!parts.title) parts.title = o.title;
    parts.alternateHooks = p.hooks.filter((h, i) => i !== p.chosen && h.text).map((h) => h.text);
    const existing = o.interviewId
      ? (await prisma.contentScript.findFirst({ where: { interviewId: o.interviewId }, select: { id: true, currentVersionId: true } })) ?? (await prisma.contentScript.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, historical: false }, orderBy: { createdAt: "asc" }, select: { id: true, currentVersionId: true } }))
      : await prisma.contentScript.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, historical: false }, select: { id: true, currentVersionId: true } });
    if (existing && o.onlyIfUnscripted) throw new AlreadyDraftedError(what);
    await claimRunWrite(run.runId);
    const record = w.writerRecordOf(p, run);
    // A plain variable, not a literal: the version's validation bag takes the writer's record beside the usual keys.
    const bag = { ok: validation.ok, findings: validation.findings, angle: null, closeType: run.output?.closeType === "callback" ? "callback" : "cta", writer: record, judge: pendingJudge(0, { writer: true }) };
    const r = await createScriptVersion({
      scriptId: existing?.id ?? null, enrollmentId: o.enrollmentId, monthId: o.monthId, topicId: o.topicId, parts, source: "AI", createdBy: o.requestedBy, status: o.interviewId ? "DRAFT" : "INTERNAL_REVIEW",
      basedOnVersionId: o.interviewId ? existing?.currentVersionId ?? null : null, interviewId: o.interviewId, answerIds: o.answerIds ?? null, callRecordId: o.callRecordId,
      strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, aiRunId: run.runId, validation: bag, gaps: [...(o.interviewGaps ?? []), ...gaps],
      changeSummary: `Drafted by the new writer from ${p.passages.length} call passage${p.passages.length === 1 ? "" : "s"}${p.g.labels.answers ? " and her written answers" : ""}, a topic brief and the best of ${p.hooks.length} hooks`,
    });
    await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
    await releaseRunKey(run.runId);
    await prisma.contentTopic.updateMany({ where: { id: o.topicId, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    await recordTopicEvent(o.topicId, o.enrollmentId, "SCRIPTED", { kind: "AI" }, { monthId: o.monthId, sourceRef: `ContentScriptVersion:${r.versionId}` });
    out = { scriptId: r.scriptId, versionId: r.versionId, versionNo: r.versionNo, ok: validation.ok, findings: validation.findings.length, gaps: (o.interviewGaps?.length ?? 0) + gaps.length };
  } finally {
    await releaseRunKey(run.runId);
  }
  await checkDraft(out.scriptId, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.checkDeadline });
  return out;
}

/** Written-answer path: a DRAFT version from the interview's exact answer rows, gaps carried through, never filled. */
export async function generateScriptFromInterview(interviewId: string, requestedBy: string, opts: { unattended?: boolean; onlyIfUnscripted?: boolean; claimedRun?: ClaimedRun | null; checkDeadline?: number | null; /** Oct 21 2026 (audit H1): a sweep's clock; the draft's model call ends by it. */ deadline?: number | null } = {}): Promise<{ scriptId: string; versionId: string; ok: boolean; gaps: number }> {
  const a = await assembleInterviewInputs(interviewId);
  await (await import("@/lib/programStyle")).assertWeWriteFor(a.enrollmentId); // Oct 8 2026: client-planned → no scripts from us
  const built = await buildClientContext(a.enrollmentId, { monthId: a.monthId });
  assertNotDiscontinued(`${a.topic.title} ${a.topic.description ?? ""}`, built.ctx, a.topic.title); // Oct 15 2026
  // Oct 22 2026: the new writer, when its switch is on for this client (it reads the answers and the call alike).
  if (a.topic.id && built.ctx.videoStyle !== "SKITS" && (await (await import("@/lib/scriptWriter/pipeline")).writerOnFor(a.enrollmentId))) {
    const r = await generateWithWriter({
      topicId: a.topic.id, monthId: a.monthId, pillarId: a.topic.pillarRef.pillarId, enrollmentId: a.enrollmentId, clientId: a.clientId, title: a.topic.title, requestedBy, unattended: opts.unattended ?? false,
      callRecordId: null, interviewId, answerIds: a.answerIds, interviewGaps: a.input.gaps, onlyIfUnscripted: !!opts.onlyIfUnscripted, claimedRun: opts.claimedRun ?? null, checkDeadline: opts.checkDeadline ?? null, deadline: opts.deadline ?? null,
    });
    return { scriptId: r.scriptId, versionId: r.versionId, ok: r.ok, gaps: r.gaps };
  }
  // The call's own words about this topic ride along beside the answers
  // (CP-08) — already confidential- and other-client-scrubbed.
  const quotableLines = a.topic.id ? await quotableLinesForTopic(a.topic.id, a.monthId, a.clientId).catch(() => []) : [];
  const bundle = buildScriptPrompt(built.ctx, { path: "written-answers", input: a.input, excerpts: a.excerpts, quotableLines });
  // The sweep path (see AlreadyDraftedError): a script for this topic in this
  // month, or for these answers, means somebody drafted it while we queued.
  if (opts.onlyIfUnscripted) await assertUnscripted(a.topic.id!, a.monthId, interviewId, `"${a.topic.title}"`);
  const run = await runAiJson<GeneratedScriptJson>({
    kind: "script_draft", enrollmentId: a.enrollmentId, clientId: a.clientId, scope: { interviewId, topicId: a.topic.id, monthId: a.monthId }, inputRefs: { ...built.inputRefs, answerIds: a.answerIds, excerpts: a.excerpts.length, quotableLines: quotableLines.length },
    promptKey: "script", promptVersion: scriptPromptVersion(built.ctx), policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: opts.unattended ?? false, dedupeKey: `script:interview:${interviewId}`, holdDedupeKey: true,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000, claimedRun: opts.claimedRun ?? null, timeoutMs: timeoutBefore(opts.deadline, 3000),
  });
  let out: { scriptId: string; versionId: string; ok: boolean; gaps: number };
  try {
    const { parts, validation, gaps, angle } = partsFromGenerated(run.output, a.topic.pillarRef.pillarId, a.clientId, { skit: built.ctx.videoStyle === "SKITS" });
    if (!parts.title) parts.title = a.topic.title;
    // ONE SCRIPT PER VIDEO (Oct 20 2026, Marcee's Malvern video). This looked
    // only for a script drafted from THESE answers, so the call path's script
    // for the same topic, written 10 seconds earlier by a run holding a
    // different key, went unseen and the video got two scripts. A script for
    // this topic in this month counts too (assertUnscripted's own test): the
    // sweep stops, and a person's explicit draft becomes its next version.
    const existing =
      (await prisma.contentScript.findFirst({ where: { interviewId }, select: { id: true, currentVersionId: true } })) ??
      (a.topic.id ? await prisma.contentScript.findFirst({ where: { topicId: a.topic.id, monthId: a.monthId, historical: false }, orderBy: { createdAt: "asc" }, select: { id: true, currentVersionId: true } }) : null);
    if (existing && opts.onlyIfUnscripted) throw new AlreadyDraftedError(`"${a.topic.title}"`);
    await claimRunWrite(run.runId); // still this run's to write (see generateScriptForTopic)
    const r = await createScriptVersion({
      scriptId: existing?.id ?? null, enrollmentId: a.enrollmentId, monthId: a.monthId, topicId: a.topic.id, parts, source: "AI", createdBy: requestedBy, status: "DRAFT",
      basedOnVersionId: existing?.currentVersionId ?? null, interviewId, answerIds: a.answerIds, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: run.runId,
      validation: draftValidation(validation, angle), gaps: [...a.input.gaps, ...gaps],
      changeSummary: existing ? "New draft from the changed answers — the earlier version is kept." : `Drafted from ${a.input.completeness.substantiveAnswered}/${a.input.completeness.substantiveTotal} substantive answers`,
    });
    await setRunOutputRef(run.runId, `ContentScriptVersion:${r.versionId}`);
    await releaseRunKey(run.runId);
    await prisma.contentTopic.updateMany({ where: { id: a.topic.id!, status: "SELECTED" }, data: { status: "SCRIPTED" } });
    out = { scriptId: r.scriptId, versionId: r.versionId, ok: validation.ok, gaps: a.input.gaps.length + gaps.length };
  } finally {
    await releaseRunKey(run.runId); // idempotent; frees the key if the write above threw
  }
  await checkDraft(out.scriptId, { requestedBy, unattended: opts.unattended ?? false, deadline: opts.checkDeadline ?? null });
  return out;
}

/** Talking point index of each lockable point section. */
const LOCK_POINT_INDEX: Partial<Record<LockableSection, number>> = { rehook: 0, buildup: 1, payoff: 2 };

/** The current version's words for a locked section, exactly as stored. */
function lockedText(base: { hook: string; close: string; captionCta: string | null; pointsJson: string }, key: LockableSection): string | null {
  if (key === "hook") return base.hook;
  if (key === "close") return base.close;
  if (key === "captionCta") return base.captionCta;
  const i = LOCK_POINT_INDEX[key];
  return i == null ? null : pointsFromJson(base.pointsJson)[i]?.text ?? null;
}

export type ReviseScriptOpts = {
  claimedRun?: ClaimedRun | null;
  /** Oct 14 2026: sections copied back from the current version BY CODE after the model answers ("Keep exactly"). Default none. */
  lockSections?: LockableSection[] | null;
  /** The automatic fix runs unattended from the cron (gated by ai_runs); a person's revision is attended. */
  unattended?: boolean;
  /**
   * Oct 14 2026: an automatic fix round (scriptJudge.ts) — written as the draft's own next version (source AI, same author), judged again.
   * Oct 22 2026, the new writer: `trim` = this is the length trim pass; `trimmed` = an earlier version already had it (carried forward).
   */
  autoFix?: { round: number; trim?: boolean; trimmed?: boolean } | null;
  /** Oct 21 2026 (audit H1): a sweep's clock (ms epoch); the model call ends by it. */
  deadline?: number | null;
};

/**
 * Revise / regenerate: a NEW version based on the current one, with the
 * instruction applied. The current version — and any manual edit in it — is
 * never overwritten; regeneratedSections says what changed.
 *
 * Oct 14 2026: the prompt is rebuilt from the script's ORIGINAL source
 * (scriptSourceFor: the written answers when it came from them), the model is
 * told to change only what the instruction asks, and locked sections are
 * copied back word for word by code. (A dash in an old locked line is still
 * taken out where every version is written: the no-dash rule wins.)
 */
export async function reviseScript(scriptId: string, instructions: string, requestedBy: string, source: "REVISION" | "CLIENT_REQUEST" = "REVISION", opts: ReviseScriptOpts = {}): Promise<{ versionId: string; versionNo: number; scriptId: string }> {
  const head = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true } });
  if (!head) throw new Error("Script not found.");
  // Historical imports are records of what was filmed — the AI never rewrites them (Jordan's ruling).
  if (head.historical) throw new Error("This is an imported historical script — it is not revised; draft a new script for the topic instead.");
  const baseId = await ensureScriptVersioned(scriptId);
  const [s, base] = await Promise.all([prisma.contentScript.findUnique({ where: { id: scriptId } }), prisma.contentScriptVersion.findUnique({ where: { id: baseId } })]);
  if (!s || !base) throw new Error("Script not found.");
  const built = await buildClientContext(s.enrollmentId, { monthId: s.monthId, excludeScriptId: scriptId });
  // Oct 13 2026: a skit stays a skit. The version being revised is a skit when
  // it carries speaker labels (one we drafted for a SKITS account, or an
  // uploaded skit), whatever the account's style is today; a SKITS account's
  // revision is written as a skit too.
  const skit = built.ctx.videoStyle === "SKITS" || !!base.speakerLabelsJson;
  if (skit) built.ctx.videoStyle = "SKITS";
  const locks = asLockSections(opts.lockSections ?? []);
  // Oct 22 2026: the instruction is kept WHOLE (on the run and on the
  // version); the change summary below stays a short line for the trail.
  const instructionRefs = { instruction: sha256(instructions), instructionText: instructions.slice(0, 20_000) };
  const autoFix = opts.autoFix ?? null;
  // Oct 22 2026: a script the new writer drafted is revised by it, from its
  // topic brief and passages (fix rounds, the trim pass, a person's revision,
  // "Apply with AI"). Everything else revises exactly as before.
  const w = skit ? null : await import("@/lib/scriptWriter/pipeline");
  const writerRec = w ? await w.latestWriterRecord(scriptId, baseId) : null;
  let raw: GeneratedScriptJson;
  let runId: string;
  let writerOut: import("@/lib/scriptWriter/prompts").DraftOut | null = null;
  if (w && writerRec) {
    const who = autoFix ? (autoFix.trim ? "trim" : "review") : source === "CLIENT_REQUEST" ? "client" : "person";
    const step = await w.writerRevisePrompt(s, writerRec, { versionNo: base.versionNo, body: base.body }, instructions, { lockedLabels: locks.map((k) => LOCKABLE_SECTION_LABEL[k]), who });
    const r = await w.runWriterStep<import("@/lib/scriptWriter/prompts").DraftOut>("revise", step, {
      requestedBy, unattended: opts.unattended ?? false, deadline: opts.deadline ?? null, scope: { scriptId, basedOnVersionId: baseId, ...(autoFix ? { autoFixRound: autoFix.round, ...(autoFix.trim ? { trim: true } : {}) } : {}) },
      enrollmentId: s.enrollmentId, clientId: s.clientId, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, inputRefs: { ...instructionRefs, who, lockSections: locks, briefRunId: writerRec.runs.brief },
    }, { dedupeKey: `revise:${scriptId}`, claimedRun: opts.claimedRun ?? null, reuse: false });
    writerOut = r.output;
    runId = r.runId;
    raw = w.generatedFromDraft(r.output, null, base.categoryLabel ?? "");
  } else {
    const { source: promptSource } = await scriptSourceFor(s, base);
    const bundle = buildScriptRevisePrompt(built.ctx, promptSource, { versionNo: base.versionNo, body: base.body }, instructions, { lockSections: locks });
    const run = await runAiJson<GeneratedScriptJson>({
      kind: "script_revise", enrollmentId: s.enrollmentId, clientId: s.clientId, scope: { scriptId, basedOnVersionId: baseId, ...(autoFix ? { autoFixRound: autoFix.round } : {}) },
      inputRefs: { ...built.inputRefs, ...instructionRefs, sourcePath: promptSource.path, lockSections: locks },
      promptKey: "script", promptVersion: scriptPromptVersion(built.ctx), policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy, unattended: opts.unattended ?? false, dedupeKey: `revise:${scriptId}`,
      system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 3000, claimedRun: opts.claimedRun ?? null, timeoutMs: timeoutBefore(opts.deadline, 3000),
    });
    runId = run.runId;
    raw = run.output;
  }
  // Locked sections: the model's words never reach the version. Put back
  // before validating (so the check describes what is written) and again on
  // the parts after the round trip through the canonical reader (byte for byte).
  const json: GeneratedScriptJson = { ...raw, points: [...(Array.isArray(raw.points) ? raw.points : [])] };
  for (const k of locks) {
    const t = lockedText(base, k);
    if (k === "hook") json.hook = t ?? "";
    else if (k === "close") json.close = t ?? "";
    else if (k === "captionCta") json.captionCta = t;
    else {
      const i = LOCK_POINT_INDEX[k]!;
      if (t != null) json.points[i] = { role: json.points[i]?.role ?? ["re-hook", "build-up", "payoff"][i], text: t };
    }
  }
  const { parts, validation, gaps, angle } = partsFromGenerated(json, base.pillarId, s.clientId, { skit });
  for (const k of locks) {
    const t = lockedText(base, k);
    if (k === "hook") parts.hook = t ?? parts.hook;
    else if (k === "close") parts.close = t ?? parts.close;
    else if (k === "captionCta") parts.captionCta = t;
    else if (t != null && parts.points[LOCK_POINT_INDEX[k]!]) parts.points[LOCK_POINT_INDEX[k]!] = { ...parts.points[LOCK_POINT_INDEX[k]!], text: t };
  }
  // The reviewer's revision must not silently recategorise the script.
  parts.categoryLabel = base.categoryLabel ?? parts.categoryLabel;
  parts.pillarId = base.pillarId;
  if (!parts.title) parts.title = base.title;
  const changed = (["hook", "points", "close", "captionCta"] as const).filter((k) => JSON.stringify(k === "points" ? parts.points.map((p) => p.text) : parts[k] ?? null) !== JSON.stringify(k === "points" ? pointsFromJson(base.pointsJson).map((p) => p.text) : base[k] ?? null));
  // The version's bag (a plain variable: it may carry the writer's record):
  // the instruction in full, and for the new writer its brief carried forward
  // with this version's rationale, and the review owed on an automatic round.
  const bag = w && writerRec
    ? {
        ok: validation.ok, findings: validation.findings, angle: null, instruction: instructions,
        closeType: writerOut?.closeType === "callback" ? "callback" : writerOut?.closeType === "cta" ? "cta" : writerRec.brief.closeType,
        writer: { ...writerRec, rationale: w.rationaleOf(writerOut) ?? writerRec.rationale },
        ...(autoFix ? { judge: pendingJudge(autoFix.round, { writer: true, trimmed: !!(autoFix.trim || autoFix.trimmed) }) } : {}),
      }
    : { ...(autoFix ? draftValidation(validation, angle, autoFix.round) : { ok: validation.ok, findings: validation.findings, angle }), instruction: instructions };
  const summary = autoFix?.trim
    ? `Trimmed by the creative review to the ${(await import("@/lib/scriptWriter/rules")).WRITER_LENGTH.cap}-word cap`
    : autoFix ? `Auto-fixed after the ${writerRec ? "creative review" : "automatic check"} (round ${autoFix.round}): ${instructions.trim().slice(0, 160)}` : `${source === "CLIENT_REQUEST" ? "Client suggestion applied" : "Revised"}: ${instructions.trim().slice(0, 160)}`;
  const r = await createScriptVersion({
    scriptId, enrollmentId: s.enrollmentId, monthId: s.monthId, topicId: s.topicId, parts, source: autoFix ? "AI" : source, basedOnVersionId: baseId, regeneratedSections: changed, createdBy: requestedBy, status: "INTERNAL_REVIEW",
    interviewId: s.interviewId, callRecordId: s.callRecordId, strategyVersionId: built.strategyVersionId, policyVersionId: built.policyVersionId, aiRunId: runId,
    validation: bag, gaps, changeSummary: summary,
  });
  await setRunOutputRef(runId, `ContentScriptVersion:${r.versionId}`);
  return { versionId: r.versionId, versionNo: r.versionNo, scriptId };
}

// --- topic refresh ------------------------------------------------------------------

type BankOut = { complete: boolean; pillars: { pillarName: string; topics: { title: string; description: string; audienceNeed: string; businessGoal: string; intendedMessage: string; sourceRef: string | null }[] }[]; gaps: Gap[] };

/** The AI half of a BANK / REFRESH run: prompt from the policy, validated, deduped against archived concepts, stored as PENDING suggestions. */
export async function executeTopicRefreshRun(runId: string, opts: { unattended: boolean; pillarId?: string | null; count?: number | null; /** Keep only the top N new suggestions (single-suggestion regeneration = 1). */ keep?: number | null; /** Oct 21 2026 (audit H1): a sweep's clock (ms epoch); the model call ends by it. */ deadline?: number | null }): Promise<void> {
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
  const existingRows = await prisma.contentTopic.findMany({ where: { enrollmentId: run.enrollmentId }, select: { title: true, concept: true, status: true, pillarId: true, pillar: true, rejectionReason: true, archiveReason: true, clientDeclinedAt: true, clientDeclineReason: true } });
  const nameOf = (id: string | null, label: string | null) => pillars.find((p) => p.id === id)?.name ?? label ?? "(no pillar)";
  // A topic the client said "not interested" to (CP-07) reads to the model as
  // ARCHIVED with their reason, and blockedTopicHashes withholds it below too.
  const existing = existingRows.map((t) => ({ title: t.title, pillarName: nameOf(t.pillarId, t.pillar), state: (t.clientDeclinedAt || t.status === "REJECTED" || t.status === "ARCHIVED" ? "ARCHIVED" : t.status === "SELECTED" || t.status === "SCRIPTED" ? "SELECTED" : ["FILMED", "DELIVERED", "EDITING"].includes(t.status) ? "FILMED" : "SUGGESTED") as Topic["state"], note: t.clientDeclinedAt ? `client not interested${t.clientDeclineReason ? `: ${t.clientDeclineReason}` : ""}` : t.rejectionReason ?? t.archiveReason ?? null,
    // What the client's pillar topics cover (Oct 20 2026): titles alone let the
    // model offer Jordan's "We Want to Move, but Where Would We Go?" back three
    // times as "The Sale and the Purchase Are One Decision, Not Two".
    concept: t.pillarId && pillars.some((p) => p.id === t.pillarId) ? t.concept : null }));
  const prevArchivedSugg = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: run.enrollmentId, disposition: "ARCHIVED" }, select: { title: true, pillarId: true } });
  for (const s of prevArchivedSugg) existing.push({ title: s.title, pillarName: nameOf(s.pillarId, null), state: "ARCHIVED", note: "archived suggestion", concept: null });
  const ctx: ClientContext = opts.pillarId
    ? { ...built.ctx, strategy: built.ctx.strategy && built.ctx.strategy.document ? { ...built.ctx.strategy, document: { ...built.ctx.strategy.document, contentPillars: { ...built.ctx.strategy.document.contentPillars, pillars: built.ctx.strategy.document.contentPillars.pillars.filter((p) => normalizeTitle(p.name) === normalizeTitle(nameOf(opts.pillarId!, null))) } } } : built.ctx.strategy }
    : built.ctx;
  // Suggestions still waiting on Jordan from earlier runs count as "existing" for
  // the prompt AND the dedupe below — a second click must not offer the same title twice.
  const pendingRows = await prisma.contentTopicSuggestion.findMany({ where: { enrollmentId: run.enrollmentId, disposition: "PENDING" }, select: { title: true, pillarId: true } });
  for (const s of pendingRows) existing.push({ title: s.title, pillarName: nameOf(s.pillarId, null), state: "SUGGESTED", note: "already suggested, awaiting review", concept: null });
  // Oct 13 2026: each pillar's emphasis (LEAD | NORMAL | LIGHT) by every name
  // it goes by, so the prompt asks a LIGHT pillar for its smaller count and
  // the validator below holds it to that count, not the full one.
  const pillarEmphasis: Record<string, string> = {};
  for (const p of pillars) for (const name of [p.name, ...p.aliases]) pillarEmphasis[name] = p.emphasis;
  const bundle = buildTopicBankPrompt(ctx, { topicsPerPillar: Math.min(Math.max(perPillar, GENERATION_POLICY.topicsPerPillar.min), GENERATION_POLICY.topicsPerPillar.max), existingTopics: existing, refresh: run.kind === "REFRESH", pillarEmphasis });
  const runRes = await runAiJson<BankOut>({
    kind: run.kind === "BANK" ? "topic_bank" : "topic_refresh", enrollmentId: run.enrollmentId, clientId: run.clientId, scope: { refreshRunId: runId, pillarId: opts.pillarId ?? null }, inputRefs: { ...built.inputRefs, existingTopics: existing.length },
    promptKey: "topic-bank", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: run.requestedBy ?? "system", unattended: opts.unattended, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 16_000, timeoutMs: timeoutBefore(opts.deadline, 16_000),
  });
  const out = runRes.output;
  const [blocked, pendingHashes] = await Promise.all([blockedTopicHashes(run.enrollmentId), pendingSuggestionHashes(run.enrollmentId)]);
  const existingHashes = new Set([...existingRows.filter((t) => t.status !== "REJECTED" && t.status !== "ARCHIVED").map((t) => topicDedupeHash(t.title)), ...pendingHashes]);
  // REWORDED IS STILL A DUPLICATE (Oct 20 2026). Erica Walker's refill came
  // back with "More Space, or Space That Actually Works Better?" beside
  // Jordan's "More Space, or Space That Works Better?": only an exact repeat
  // was caught. A fresh idea that reads like a topic on file (any pillar at
  // NEAR_DUPLICATE_THRESHOLD, its own pillar at SAME_PILLAR_NEAR) is dropped;
  // like an archived, rejected or "I don't like this one" topic, it is
  // withheld, so a turned-down idea does not come back in new words either.
  // (Two ideas of the same run are the validator's near-duplicate check.)
  const SAME_PILLAR_NEAR = 0.6;
  const onFile = [
    ...existingRows.map((t) => ({ title: t.title, pillarId: t.pillarId, gone: t.status === "REJECTED" || t.status === "ARCHIVED" || !!t.clientDeclinedAt })),
    ...pendingRows.map((s) => ({ title: s.title, pillarId: s.pillarId, gone: false })),
    ...prevArchivedSugg.map((s) => ({ title: s.title, pillarId: s.pillarId, gone: true })),
  ];
  const nearOnFile = (title: string, pillarId: string | null) => onFile.find((r) => { const sim = titleSimilarity(title, r.title); return sim >= NEAR_DUPLICATE_THRESHOLD || (!!pillarId && r.pillarId === pillarId && sim >= SAME_PILLAR_NEAR); });
  const bank: TopicBank = { clientId: run.clientId, clientName: built.ctx.clientName, intro: [], strategyVersion: built.strategyLabel, stamp: policyStamp(built.strategyLabel), pillars: [] };
  for (const p of Array.isArray(out.pillars) ? out.pillars : []) {
    const pillarId = await resolvePillarByLabel(run.enrollmentId, p.pillarName);
    bank.pillars.push({ pillarId, name: p.pillarName, purpose: null, topics: (p.topics ?? []).map((t) => makeTopic({ title: t.title, pillarName: p.pillarName, description: t.description, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, source: "GENERATED", sourceRef: t.sourceRef, clientId: run.clientId, pillarRef: { pillarId, pillarName: p.pillarName } })) });
  }
  const validation = validateTopicBank(bank, { topicsPerPillar: perPillar, mode: "generated", strategyPillarNames: strategyPillars.map((p) => p.name), pillarEmphasis });
  let created = 0, resurfaced = 0, duplicates = 0, notKept = 0;
  const formulaic: string[] = [];
  // Oct 15 2026: an idea that names a series this client stopped never reaches the bank.
  const stopped: string[] = [];
  const rows: Prisma.ContentTopicSuggestionCreateManyInput[] = [];
  for (const p of bank.pillars) {
    if (!p.pillarId) continue; // an unknown pillar name is a finding, never a new pillar
    let rank = 0;
    for (const t of p.topics) {
      const hash = topicDedupeHash(t.title);
      if (blocked.has(hash)) { resurfaced++; continue; } // archived/rejected concepts never come back
      { const hit = discontinuedHit(`${t.title} ${t.description ?? ""} ${t.intendedMessage ?? ""}`, built.ctx.creativeGuard); if (hit) { stopped.push(`${t.title} (${hit})`); continue; } }
      // Oct 14 2026: a banned formulaic title shape the prompt asked the model not to use is dropped, and logged.
      const shape = formulaicTitleShape(t.title);
      if (shape) { formulaic.push(`${t.title} (${shape})`); continue; }
      if (existingHashes.has(hash)) { duplicates++; continue; }
      { const near = nearOnFile(t.title, p.pillarId); if (near) { if (near.gone) resurfaced++; else duplicates++; continue; } }
      if (opts.keep && rank >= opts.keep) { notKept++; continue; } // "regenerate ONE": the replacement is the first fresh idea, the rest are not stored
      existingHashes.add(hash);
      rows.push({ refreshRunId: runId, enrollmentId: run.enrollmentId, clientId: run.clientId, pillarId: p.pillarId, kind: "BANK", rank: ++rank, title: t.title.slice(0, 200), description: t.description, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, intendedMessage: t.intendedMessage, rationale: t.sourceRef ? `Grounded in: ${t.sourceRef}` : "Inferred from the pillar's focus areas", dedupeHash: hash });
      created++;
    }
  }
  if (rows.length) await prisma.contentTopicSuggestion.createMany({ data: rows });
  // HANDS OFF (Jordan, Oct 14 2026: "as hands off as possible"). A bank's
  // ideas used to wait for staff to accept each one before the client could
  // see it, so a client with an empty bank had nothing to pick. Ideas that
  // passed the checks above (no duplicate, no archived concept, no formulaic
  // title) are accepted straight into the bank. Staff can still archive one.
  if (rows.length && (await import("@/lib/programAutomation").then((m) => m.isAutomationEnabled("topic_auto_accept")).catch(() => false))) {
    try {
      const { acceptSuggestions } = await import("@/lib/contentTopics");
      const fresh = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: runId, disposition: "PENDING" }, select: { id: true } });
      if (fresh.length) await acceptSuggestions(fresh.map((s) => s.id), "auto:topic-bank");
    } catch (e) { console.warn(`[topic bank] run ${runId}: auto-accept failed, ideas stay pending`, e); }
  }
  if (formulaic.length) console.warn(`[topic bank] run ${runId}: dropped ${formulaic.length} formulaic title(s): ${formulaic.join(" | ").slice(0, 600)}`);
  if (stopped.length) console.warn(`[topic bank] run ${runId}: dropped ${stopped.length} idea(s) naming a discontinued series: ${stopped.join(" | ").slice(0, 600)}`);
  await setRunOutputRef(runRes.runId, `ContentTopicRefreshRun:${runId}`);
  const unknownPillars = validation.findings.filter((f) => f.code === "pillar.unknown").map((f) => f.message);
  const gaps = [...(Array.isArray(out.gaps) ? out.gaps : []), ...validation.gaps];
  const status = created === 0 ? "NEEDS_INPUT" : "SUCCEEDED";
  await finishRefreshRun(runId, {
    status, generatedCount: created, pillarCount: bank.pillars.length, aiRunId: runRes.runId,
    missingContext: gaps.length || unknownPillars.length || !out.complete ? { gaps: gaps.map((g) => g.text), unknownPillars, complete: out.complete === true } : undefined,
    changeSummary: `${created} new suggestion${created === 1 ? "" : "s"}${opts.keep ? ` (kept ${created} of ${created + notKept} fresh ideas as the replacement)` : ""} · ${duplicates} already in the bank · ${resurfaced} archived concept${resurfaced === 1 ? "" : "s"} withheld · ${validation.duplicates.length} near-duplicate warning${validation.duplicates.length === 1 ? "" : "s"}${formulaic.length ? ` · ${formulaic.length} formulaic title${formulaic.length === 1 ? "" : "s"} dropped` : ""}${stopped.length ? ` · ${stopped.length} idea${stopped.length === 1 ? "" : "s"} from a discontinued series dropped` : ""}${out.complete === false ? " · the model reported it could not reach the count at the quality bar" : ""}`,
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
  selectedTopics: { title: string; concept: string; pillar: string | null; excerpts: Excerpt[]; quotableLines?: string[] }[];
  discussedTopics: { title: string; concept: string; pillar: string | null; excerpts: Excerpt[] }[];
  rejectedIdeas: { title: string; reason: string | null }[];
  // CP-11: proposedValue / section / proposedText / confidential — what exactly
  // a preference or a strategy section would change to (profileFields.ts).
  facts: { body: string; category: FactCategory; fieldKey: string | null; scope: "PERMANENT" | "MONTH" | "PROJECT"; speaker: string | null; confidential: boolean; confidence: number; excerpt: Excerpt | null; proposedValue?: string | null }[];
  strategyProposals: { kind: "STRATEGY" | "PILLAR" | "AUDIENCE" | "POSITIONING" | "PREFERENCE"; summary: string; impact: string | null; section?: string | null; proposedText?: string | null; confidential?: boolean }[];
  priorities: string[];
  todos: string[];
};

// WHAT "CONFIDENTIAL" MEANS (Oct 14 2026). Jordan, Oct 13: "The only thing
// that should be confidential is if they say so on the strategy call." It
// used to be "told in confidence or commercially sensitive", which marked a
// client's own market ("Lehigh Valley") confidential and then blocked their
// strategy. Used by the call analysis (planning and discovery) for facts and
// for strategy proposals.
export const CONFIDENTIAL_ONLY_WHEN_ASKED =
  "true ONLY when the client explicitly asks to keep it private or off camera (e.g. 'don't share this', 'off the record', 'between us', 'keep this private'). Commercially sensitive or personal is not enough on its own.";
const EXCERPT_SCHEMA = { type: "object", required: ["speaker", "text"], properties: { speaker: { type: "string", enum: ["client", "jordan", "third-party"] }, speakerName: { type: ["string", "null"] }, time: { type: ["string", "null"] }, text: { type: "string" } } };
const TOPIC_SCHEMA = { type: "object", required: ["title", "concept", "excerpts"], properties: { title: { type: "string" }, concept: { type: "string" }, pillar: { type: ["string", "null"] }, excerpts: { type: "array", items: EXCERPT_SCHEMA } } };
// Oct 14 2026: the client's own sharp lines about a topic they agreed to film,
// for the script prompt ("CLIENT'S OWN LINES"). Optional, selected topics
// only; the instruction rides in the field description, so the analysis
// prompt's own wording is untouched.
const SELECTED_TOPIC_SCHEMA = {
  ...TOPIC_SCHEMA,
  properties: {
    ...TOPIC_SCHEMA.properties,
    quotableLines: { type: "array", maxItems: 5, items: { type: "string" }, description: "Optional. The client's own sharpest opinions or phrasing about this topic, VERBATIM, client-spoken only (never Jordan's or anyone else's words). Leave empty when there is none." },
  },
};
const ANALYSIS_SCHEMA = {
  type: "object",
  required: ["callKind", "plannedMonthKey", "selectedTopics", "discussedTopics", "rejectedIdeas", "facts", "strategyProposals", "priorities", "todos"],
  properties: {
    callKind: { type: "string", enum: ["planning", "discovery", "review", "other"] },
    plannedMonthKey: { type: ["string", "null"], description: "YYYY-MM the selected topics are FOR, or null" },
    selectedTopics: { type: "array", items: SELECTED_TOPIC_SCHEMA, description: "Topics the CLIENT explicitly agreed to film — each with a client-spoken excerpt proving it" },
    discussedTopics: { type: "array", items: TOPIC_SCHEMA, description: "Ideas raised but not agreed — saved for the bank" },
    rejectedIdeas: { type: "array", items: { type: "object", required: ["title"], properties: { title: { type: "string" }, reason: { type: ["string", "null"] } } } },
    facts: { type: "array", items: { type: "object", required: ["body", "category", "scope", "confidential", "confidence"], properties: { body: { type: "string" }, category: { type: "string", enum: ["BRAND_PREFERENCE", "PRODUCTION_PREFERENCE", "PERFORMANCE_REPORTED", "DECISION", "COMMITMENT", "FEEDBACK", "PROPOSED_CHANGE"] }, fieldKey: { type: ["string", "null"], description: "e.g. editing.music, editing.pace, editing.captions, production.location_preference, production.preferred_days, production.wardrobe, production.teleprompter, brand.fonts, brand.website, brand.social, brand.voice — or null" }, scope: { type: "string", enum: ["PERMANENT", "MONTH", "PROJECT"] }, speaker: { type: ["string", "null"] }, confidential: { type: "boolean" }, confidence: { type: "number" }, excerpt: { anyOf: [EXCERPT_SCHEMA, { type: "null" }] }, proposedValue: { type: ["string", "null"], description: "When the client CHANGED a standing preference: the new standing value in a few words (e.g. 'Calm acoustic'). Otherwise null." } } } },
    strategyProposals: { type: "array", items: { type: "object", required: ["kind", "summary"], properties: { kind: { type: "string", enum: ["STRATEGY", "PILLAR", "AUDIENCE", "POSITIONING", "PREFERENCE"] }, summary: { type: "string" }, impact: { type: ["string", "null"] }, section: { type: ["string", "null"], description: "The heading, EXACTLY as listed under APPROVED STRATEGY SECTION HEADINGS, of the ONE section this changes — or null" }, proposedText: { type: ["string", "null"], description: "Replacement text for that one section only, in the section's own style — or null" }, confidential: { type: "boolean", description: CONFIDENTIAL_ONLY_WHEN_ASKED } } } },
    priorities: { type: "array", items: { type: "string" } },
    todos: { type: "array", items: { type: "string" } },
  },
};

const ANALYSIS_SYSTEM = (videosOwed: number, history: string) =>
  "You are processing a call transcript for a real-estate agent's monthly video program. FIRST judge what kind of call this is (planning / discovery / review / other). " +
  "If it is a planning session, set plannedMonthKey to the month the topics are FOR (a call in the last third of a month usually plans the NEXT month). Use the call date in the prompt.\n" +
  "Report what the CLIENT actually agreed to, not everything mentioned: selectedTopics need a client-spoken excerpt each; discussedTopics are ideas without agreement; rejectedIdeas were explicitly declined. " +
  "facts: NEW durable facts about the agent (preferences, decisions, commitments, reported results) — quote or closely paraphrase, with speaker and an excerpt; scope PROJECT for 'let's try X on this one', MONTH for this month only, PERMANENT otherwise; confidential=" + CONFIDENTIAL_ONLY_WHEN_ASKED + " " +
  "strategyProposals: only when the client changes positioning, audience, pillars or a standing preference — a proposal for staff, never a rewrite. Name the ONE approved section it changes (its heading exactly) and give replacement text for that section only; leave both null if no single section fits. confidential=" + CONFIDENTIAL_ONLY_WHEN_ASKED + " " +
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
  // Oct 15 2026 (Marcee McMullen): topics are often chosen in the portal WITH
  // the client during the call. The model gets them by name so what she said
  // about each lands on THAT topic (createTopic matches the exact title), not
  // on a re-worded twin that strands the chosen one with no call material.
  const chosenRows = await prisma.contentTopicSelection.findMany({ where: { monthId: o.monthId, status: { in: ["SELECTED", "RECONCILED", "CARRIED"] } }, select: { topicId: true } });
  const chosenTitles = chosenRows.length ? (await prisma.contentTopic.findMany({ where: { id: { in: chosenRows.map((r) => r.topicId) } }, select: { title: true } })).map((t) => t.title) : [];
  const chosenBlock = chosenTitles.length ? `TOPICS ALREADY CHOSEN FOR THIS MONTH (picked before or during this call). When the call talks one of these through, report it in selectedTopics with its title EXACTLY as written here, with the client's excerpts and quotable lines:\n${chosenTitles.map((t) => `- ${t}`).join("\n")}\n\n` : "";
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
    prompt: `CLIENT: ${built.ctx.clientName} (id ${o.clientId})\nCALL DATE: ${o.callDate ? o.callDate.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric" }) : `sometime in ${o.monthKey}`}\n\n${context}\n\n${headings.length ? `APPROVED STRATEGY SECTION HEADINGS (use one exactly in strategyProposals[].section):\n${headings.map((h) => `- ${h}`).join("\n")}\n\n` : ""}${facts.length ? `ACCEPTED FACTS ON FILE:\n${facts.map((f) => `- ${f}`).join("\n")}\n\n` : ""}${chosenBlock}TRANSCRIPT:\n${o.transcript.slice(0, 150_000)}`,
    schema: ANALYSIS_SCHEMA, maxTokens: 10_000,
  });
  const out = run.output;
  // Which month the selections are FOR. A call RECORD is already filed on its
  // month by the hub's own rule (contentCallRecords.targetMonthFor: held on or
  // after the 24th → next month) or by a person on the calls desk, and that
  // filing wins. The model's guess only ever moved a call's results onto a
  // wrong month (Oct 12 2026: Erica's Sep 24 call onto October; Arielle's
  // Sep 11 call onto a November it created and marked "call completed",
  // because the call mentioned her November anniversary). It is honoured only
  // for a bare transcript (no call record) held late in the month, and only
  // for the very next month — the same rule the call records follow.
  let targetMonthId = o.monthId;
  const planned = typeof out.plannedMonthKey === "string" && /^\d{4}-\d{2}$/.test(out.plannedMonthKey) ? out.plannedMonthKey : null;
  const { etDayKey } = await import("@/lib/datetime");
  const nextOf = (k: string) => { const [y, m] = k.split("-").map(Number); return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`; };
  const lateInMonth = !!o.callDate && Number(etDayKey(o.callDate).slice(8, 10)) >= 24;
  if (planned && planned !== o.monthKey && !o.callRecordId && planned === nextOf(o.monthKey) && lateInMonth) {
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
  // Oct 14 2026: a quotable line is kept only when it is really in the
  // transcript (verbatim, ignoring case, spacing and punctuation).
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const transcriptFlat = flat(o.transcript);
  const quotable = (q: unknown): string[] => (Array.isArray(q) ? q : []).filter((x): x is string => typeof x === "string" && flat(x).length >= 8 && transcriptFlat.includes(flat(x))).map((x) => x.trim().slice(0, 300)).slice(0, 5);
  for (const t of Array.isArray(out.selectedTopics) ? out.selectedTopics : []) {
    if (!t.title?.trim()) continue;
    const excerpts = toExcerpts(t.excerpts);
    const quotableLines = quotable(t.quotableLines);
    const r = await createTopic({ enrollmentId: o.enrollmentId, title: t.title, concept: t.concept, pillarLabel: t.pillar, source: "strategy_call", sourceRef, status: "SAVED", approvalState: "PROPOSED", actor, eventKind: "DISCUSSED", evidence: { excerpts, ...(quotableLines.length ? { quotableLines } : {}) }, note: "Raised on the call" });
    // A call PROPOSES; a person reconciles (spec §5: discussed ≠ selected). A
    // re-analysis never downgrades what a person already decided: the topic
    // layer keeps SELECTED/RECONCILED rows, leaves REMOVED ones removed and
    // withholds rejected/archived topics — each with the mention on the history.
    const sel = await selectTopicForMonth(r.id, targetMonthId, { source: "call", actor, callRecordId: o.callRecordId ?? null, evidence: { excerpts, clientSpoken: excerpts.some((e) => e.speaker === "client"), ...(quotableLines.length ? { quotableLines } : {}) }, status: "PROPOSED" });
    // A topic agreed on the strategy call is the client's choice made with us:
    // it is confirmed at once (Jordan, Oct 13 2026, "both": no "needs
    // reconciling" step before its script is drafted). The same write as a
    // person's Keep. Anything the topic layer withheld (rejected, declined,
    // removed by a person) never reaches here, and ideas the client turned
    // down on the call stay proposed rejections for a person to rule on.
    if (sel.outcome === "PROPOSED") {
      const { reconcileSelection } = await import("@/lib/contentTopics");
      await reconcileSelection(r.id, targetMonthId, true, actor).catch(() => null);
    }
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

/** The call, its CONFIRMED transcript text and the month it plans — shared by the queue's handlers and a person's "Analyze the call" (callAnalysis.ts, Oct 12 2026). */
export async function callAndTranscript(job: TranscriptJobInput) {
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
 *
 * EVERY QUEUED RUN IS UNATTENDED (R05, Sep 28 2026). This used to decide from
 * the requester's NAME (`cron` / `system` / none), but the real requesters
 * are "drive-sweep" (the Drive discovery), "onboarding-cron" (a discovery
 * call's strategy draft) and the email of whoever confirmed or pasted a
 * transcript — all of which read as a person pressing a button. Two effects:
 * ai_runs (aiRuns.runAiJson) was skipped, so turning transcript_jobs on by
 * itself would have spent AI credit with the master switch off; and
 * fact_extraction's auto-accept (clientFacts.createFact, unattended only)
 * never applied to queued call analysis. The only way in here is the queue
 * driver (contentPipeline.transcriptJobHandlers ← transcriptJobs), and nobody
 * is watching a queued job run, so it is unattended — always. requestedBy is
 * kept for attribution only. The buttons a person presses (Draft strategy
 * now, Draft owed scripts, Re-analyse) run inline, not through here, and stay
 * attended by design (aiRuns.ts). The cost of the change: an owner's Re-run
 * of a queued job (Settings → Calendly & calls) now waits for ai_runs too.
 */
export async function runTranscriptJob(job: TranscriptJobInput): Promise<TranscriptJobOutcome> {
  const requestedBy = job.requestedBy ?? "cron";
  const unattended = true;
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
        // Oct 8 2026: a client who plans their own content writes their own scripts — the job is done with nothing drafted.
        if (await (await import("@/lib/programStyle")).clientPlansOwnContent(enrollment.id)) return { ok: true, resultJson: { versionIds: [], skipped: 0, clientPlanned: true } };
        // Only RECONCILED/SELECTED topics get scripts; call-proposed ones wait for a person.
        const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: month.id, status: { in: ["SELECTED", "RECONCILED"] } }, select: { topicId: true } });
        const done: string[] = [];
        let skipped = 0;
        for (const s of sels) {
          const has = await prisma.contentScript.findFirst({ where: { topicId: s.topicId, monthId: month.id, historical: false }, select: { id: true } });
          if (has) { skipped++; continue; }
          await beat(); // one lease refresh per script — a month of drafts can outlast a 10-minute lease
          // Oct 14 2026: checkDeadline 0 = the automatic check of these drafts is left to the AI cron (scriptJudge.sweepScriptChecks): this loop drafts a whole month with no clock of its own.
          const g = await generateScriptForTopic({ topicId: s.topicId, monthId: month.id, requestedBy, unattended, callRecordId: call.id, checkDeadline: 0 });
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
export async function draftStrategyFromTranscript(o: { enrollmentId: string; clientId: string; transcript: string; callRecordId?: string | null; callDate?: Date | null; intakeText?: string | null; requestedBy: string; unattended: boolean; claimedRun?: ClaimedRun | null }): Promise<{ versionId: string; versionNo: number; gaps: number; runId: string; stripped: number }> {
  const built = await buildClientContext(o.enrollmentId);
  const scrub = await scrubTranscriptForGeneration(o.clientId, o.transcript);
  // The intake is stored as JSON; one answer per line, so a private answer is held back without the rest.
  const intakeLines = (() => { if (!o.intakeText) return null; try { return JSON.stringify(JSON.parse(o.intakeText), null, 1); } catch { return o.intakeText; } })();
  const intake = intakeLines ? await scrubTranscriptForGeneration(o.clientId, intakeLines) : null;
  const excerptCtx: ClientContext = { ...built.ctx, sourceExcerpts: [{ speaker: "client", speakerName: built.ctx.clientName, source: "discovery-call transcript (speaker turns not separated — treat lines as the client's only where the transcript says so)", text: scrub.text.slice(0, 120_000) }] };
  const bundle = buildStrategyPrompt(excerptCtx, { intakeText: intake?.text ?? null, priorStrategyNote: built.ctx.strategy ? `An approved strategy (${built.strategyLabel}) exists; this draft is a proposed new version, not a replacement.` : null });
  type StrategyOut = { clientName: string; subtitle: string; brandOverview: { coreValues: string; brandMessage: string; shortBrandStatement: string | null; brandVoice: string }; targetAudience: { primaryServiceAreas: string; pricePositioning: string | null; primaryClientTypes: string; longTermPositioningGoal: string }; contentGoals: string[]; contentPillars: { preamble: string; pillars: { name: string; purpose: string; focusAreas: string; contentApproach: string | null }[] }; framework: string; captionCtaExamples: string[]; strategicDirection: string; gaps: Gap[] };
  const run = await runAiJson<StrategyOut>({ kind: "strategy_draft", enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { callRecordId: o.callRecordId ?? null }, inputRefs: { ...built.inputRefs, transcriptHash: sha256(o.transcript), stripped: scrub.stripped, strippedBy: scrub.reasons, intakeStripped: intake?.stripped ?? 0 }, promptKey: "strategy", promptVersion: `${GENERATION_POLICY_VERSION}/strategy.2-scrubbed`, policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId, requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: o.callRecordId ? `strategy:${o.callRecordId}` : null, system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 12_000, claimedRun: o.claimedRun ?? null });
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

export async function reviseStrategyWithFeedback(versionId: string, fb: { notes?: string | null; proposalIds?: string[] | null; /** Oct 13 2026: the caller already claimed these (ACCEPTED by `by`, no result yet) — acceptStrategyProposal. */ preclaimed?: boolean }, by: string): Promise<{ versionId: string; versionNo: number; existed: boolean; changedSections: string[]; unaddressed: string[]; ignoredSections: string[]; proposalsFolded: number; runId: string | null }> {
  const base = await prisma.contentStrategyVersion.findUnique({ where: { id: versionId } });
  if (!base) throw new Error("Strategy version not found.");
  if (!["DRAFT", "INTERNAL_REVIEW", "APPROVED"].includes(base.status)) throw new Error(`v${base.versionNo} is ${base.status.toLowerCase()} — revise the newest version instead.`);
  const stored = parseStoredSections(base.sectionsJson);
  if (!stored?.sections.length) throw new Error("That version's sections can't be read.");
  const notes = (fb.notes ?? "").trim().slice(0, 4000);
  if (CONFIDENTIAL_RE.test(notes)) throw new Error("Take the [CONFIDENTIAL] marker out of your notes — the strategy is shown to the client.");
  const ids = [...new Set((fb.proposalIds ?? []).filter((x) => typeof x === "string" && x))];
  const proposals = ids.length
    ? await prisma.contentStrategyProposal.findMany({ where: { id: { in: ids }, enrollmentId: base.enrollmentId, ...(fb.preclaimed ? { status: "ACCEPTED", resolvedBy: by, resultVersionId: null } : { status: "PROPOSED" }), OR: [{ targetKey: null }, { NOT: { targetKey: { startsWith: "profile." } } }] }, orderBy: { createdAt: "asc" } })
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
  // Oct 6 2026: the model sees the house framework in section 4, never the imported document's own.
  const bundle = buildStrategyRevisionPrompt(built.ctx, { label: `v${base.versionNo}`, sections: stored.sections.map((x) => ({ id: x.id, heading: x.heading, text: isFrameworkSection(x) ? canonicalFrameworkSectionText(x.text) : x.text })) }, {
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
    const unaddressed = Array.isArray(run.output.unaddressed) ? run.output.unaddressed.filter((x) => typeof x === "string" && x.trim()) : [];
    for (const c of Array.isArray(run.output.changes) ? run.output.changes : []) {
      if (c && typeof c.sectionId === "string" && known.has(c.sectionId) && typeof c.text === "string" && c.text.trim()) {
        // Oct 13 2026: a "complete new body" that came back as a fraction of the
        // section (a fragment, or an instruction about it) would wipe out the
        // rest of the section. Not applied; the person edits it by hand.
        const before = stored.sections.find((x) => x.id === c.sectionId)?.text ?? "";
        if (before.length >= 300 && c.text.trim().length < before.length * 0.6) {
          unaddressed.push(`the rewrite of "${stored.sections.find((x) => x.id === c.sectionId)?.heading ?? c.sectionId}" came back much shorter than the section, so it was not applied`);
          continue;
        }
        replace.set(c.sectionId, c.text);
      } else ignoredSections.push(String(c?.sectionId ?? "?"));
    }
    const summary = typeof run.output.summary === "string" && run.output.summary.trim() ? run.output.summary.trim() : "changes from the feedback";
    await claimRunWrite(run.runId); // still this run's to write (see generateScriptForTopic)
    const r = await deriveStrategyVersion({ baseId: base.id, replace, by, sourceKind: "ai", aiRunId: run.runId, changeSummary: `Revised with feedback${proposals.length ? ` (${proposals.length} client suggestion${proposals.length === 1 ? "" : "s"} folded in)` : ""}: ${summary}` });
    let proposalsFolded = 0;
    if (r.versionId !== base.id && proposals.length) {
      const won = fb.preclaimed
        ? await prisma.contentStrategyProposal.updateMany({ where: { id: { in: proposals.map((p) => p.id) }, status: "ACCEPTED", resolvedBy: by, resultVersionId: null }, data: { resultVersionId: r.versionId } })
        : await prisma.contentStrategyProposal.updateMany({
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
export async function planInterviewQuestions(interviewId: string, o: { requestedBy: string; unattended: boolean; /** The sweep's clock (ms epoch): the model call ends by it (audit H1). */ deadline?: number | null }): Promise<{ runId: string; questions: number; followUps: number }> {
  const { interviewPlanningContext } = await import("@/lib/contentInterview");
  const { INTERVIEW_QUESTION_PLAN } = await import("@/lib/contentPolicy");
  const { buildInterviewPlanPrompt } = await import("@/lib/contentPolicy/prompts");
  const ctxRow = await interviewPlanningContext(interviewId);
  await (await import("@/lib/programStyle")).assertWeWriteFor(ctxRow.enrollmentId); // Oct 8 2026: client-planned → no questions from us
  const built = await buildClientContext(ctxRow.enrollmentId, { monthId: ctxRow.monthId });
  const bundle = buildInterviewPlanPrompt(built.ctx, { topic: ctxRow.topic, plan: INTERVIEW_QUESTION_PLAN });
  type PlanOut = { questions: { id: string; ask: string }[]; followUps: { key: string; ask: string }[] };
  const run = await runAiJson<PlanOut>({
    kind: "interview_plan", enrollmentId: ctxRow.enrollmentId, clientId: ctxRow.clientId, scope: { interviewId, topicId: ctxRow.topic.id, monthId: ctxRow.monthId },
    inputRefs: { ...built.inputRefs, topicTitle: ctxRow.topic.title }, promptKey: "interview-plan", policyVersionId: built.policyVersionId, strategyVersionId: built.strategyVersionId,
    requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: `interview-plan:${interviewId}`,
    system: bundle.system, prompt: bundle.user, schema: bundle.outputSchema, maxTokens: 2000, timeoutMs: timeoutBefore(o.deadline, 2000),
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

export const GENERATION_KINDS: AiRunKind[] = ["call_analysis", "strategy_draft", "strategy_revise", "topic_bank", "topic_refresh", "recommendation", "script_draft", "script_revise", "interview_plan", "script_judge", "creative_identity", "script_retrieval", "script_brief", "script_hooks", "script_review"];
