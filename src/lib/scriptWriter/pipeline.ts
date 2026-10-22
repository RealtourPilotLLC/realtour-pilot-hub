import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson, sha256, type AiRunKind, type ClaimedRun } from "@/lib/aiRuns";
import { timeoutBefore, type AiEffort } from "@/lib/integrations/ai";
import type { GeneratedScriptJson, Gap } from "@/lib/contentPolicy";
import { gatherForTopic, type Gathered, type GatherOpts } from "./sources";
import { buildRetrievalPrompt, buildBriefPrompt, buildHooksPrompt, buildDraftPrompt, buildReviewPrompt, buildReviseWriterPrompt, type DraftOut, type StepPrompt, type WriterContext } from "./prompts";
import { locateQuote, contextAround, timeOf, isInternalTalk } from "./passages";
import { pickHook, hardNumbers, mergeReview, mustFixFailures, trimInstruction, spokenTextOf, WRITER_LENGTH, WRITER_VERSION, estimateSeconds, type HookCandidate, type ReviewCheckResult, type HardFinding, type ScriptParts } from "./rules";
import { readWriter, type TopicBrief, type WriterPassage, type WriterRecord, type WriterRationale } from "./record";

// ---------------------------------------------------------------------------
// THE NEW SCRIPT WRITER (Oct 22 2026): phases 1 and 2 of the approved plan.
//
//   gather      sources.ts: the topic's call in full, older call windows, her
//               facts (unreviewed client-spoken ones too), same-subject scripts,
//               voice examples, why the topic was chosen                (no AI)
//   retrieval   every passage where she talks about the topic, verbatim, found
//               in the source by code with the lines around it; internal talk
//               held back                          (claude-opus-5-5, medium)
//   brief       the topic brief                    (claude-opus-5-5, medium)
//   hooks       five hooks with re-hooks, scored; code keeps the best
//                                                  (claude-opus-5-5, high)
//   draft       the five-part script; the winning hook word for word
//                                                  (claude-opus-5-5, high)
//   review      the independent creative review: 12 checks + code's hard
//               numbers; up to two fix rounds and one trim pass; a script that
//               still fails a must-fix arrives FLAGGED (scriptJudge.ts runs
//               this loop on the version trail)    (claude-opus-5-5, high)
//
// Every step is a ProgramAiRun (kind script_retrieval / script_brief /
// script_hooks / script_draft / script_review / script_revise). A step whose
// exact prompt already ran in the last two days reuses that run's answer, so a
// sweep that runs out of time (WriterPausedError) picks up where it stopped on
// the next tick instead of paying again.
//
// THE SWITCH. AppSetting "script_writer_v2" ({ "on": true } or { "on": true,
// "enrollmentIds": [...] } for a pilot). Missing or off = the writer the hub
// has used since Oct 14 drafts every script, exactly as before. Phase 3 (the
// test on Marcee's three cases, draftOffline below) decides when it goes on.
// A script the new writer drafted is revised and reviewed by it from then on.
// Skit accounts stay on the current writer (no skit-aware brief yet).
//
// Never touched: a version that is approved or shared, or any script a client
// has been sent (the review loop only acts on a DRAFT / INTERNAL_REVIEW
// current version of a script with nothing shared). Every draft still lands in
// Jordan's review queue; script_auto_share stays TEST-locked.
// ---------------------------------------------------------------------------

export const WRITER_SWITCH_KEY = "script_writer_v2";
export type WriterSwitch = { on: boolean; enrollmentIds: string[] | null };

/** The switch, read fresh every time. Anything unreadable is OFF. */
export async function writerSwitch(): Promise<WriterSwitch> {
  const row = await prisma.appSetting.findUnique({ where: { key: WRITER_SWITCH_KEY }, select: { value: true } }).catch(() => null);
  if (!row) return { on: false, enrollmentIds: null };
  try {
    const v = JSON.parse(row.value) as { on?: unknown; enrollmentIds?: unknown };
    const ids = Array.isArray(v.enrollmentIds) ? v.enrollmentIds.filter((x): x is string => typeof x === "string") : null;
    return { on: v.on === true, enrollmentIds: ids };
  } catch { return { on: false, enrollmentIds: null }; }
}

export async function writerOnFor(enrollmentId: string): Promise<boolean> {
  const s = await writerSwitch();
  return s.on && (!s.enrollmentIds || s.enrollmentIds.includes(enrollmentId));
}

/** Out of the caller's time before the next step: nothing went wrong, the next run carries on (finished steps are reused). */
export class WriterPausedError extends Error {
  constructor(step: string) { super(`The new writer paused before the ${step} step to stay inside this run's time; the next run carries on from there (finished steps are kept).`); this.name = "WriterPausedError"; }
}

type Step = "retrieval" | "brief" | "hooks" | "draft" | "review" | "revise";
const STEP_KIND: Record<Step, AiRunKind> = { retrieval: "script_retrieval", brief: "script_brief", hooks: "script_hooks", draft: "script_draft", review: "script_review", revise: "script_revise" };
/** Jordan's ruling via the brief: high for the draft and the review, medium for reading the sources and the brief. */
export const STEP_EFFORT: Record<Step, AiEffort> = { retrieval: "medium", brief: "medium", hooks: "high", draft: "high", review: "high", revise: "high" };
/** Room for the thinking as well as the answer (thinking counts toward max_tokens). */
export const STEP_MAX_TOKENS: Record<Step, number> = { retrieval: 16_000, brief: 12_000, hooks: 8_000, draft: 12_000, review: 10_000, revise: 12_000 };
const STEP_MIN_START_MS: Record<Step, number> = { retrieval: 75_000, brief: 60_000, hooks: 45_000, draft: 60_000, review: 45_000, revise: 60_000 };
const REUSE_MS = 48 * 3600_000;

export type RunCtx = { requestedBy: string; unattended: boolean; deadline?: number | null; scope: Record<string, unknown>; enrollmentId: string; clientId: string; strategyVersionId: string | null; policyVersionId: string | null; inputRefs?: Record<string, unknown> };

/** One writer step: a reused answer when this exact prompt already ran, else one model call on the writer's path. */
export async function runWriterStep<T>(step: Step, prompt: StepPrompt, rc: RunCtx, opts: { dedupeKey?: string | null; holdDedupeKey?: boolean; claimedRun?: ClaimedRun | null; reuse?: boolean; kind?: AiRunKind } = {}): Promise<{ output: T; runId: string; reused: boolean }> {
  const kind = opts.kind ?? STEP_KIND[step];
  if (opts.reuse !== false && !opts.claimedRun && !opts.holdDedupeKey) {
    const hash = sha256(`${prompt.system}\n${prompt.prompt}`);
    const prev = await prisma.programAiRun.findFirst({ where: { kind, enrollmentId: rc.enrollmentId, status: "SUCCEEDED", inputRefsJson: { contains: hash }, createdAt: { gte: new Date(Date.now() - REUSE_MS) } }, orderBy: { createdAt: "desc" }, select: { id: true, outputJson: true } });
    if (prev?.outputJson) {
      try { return { output: JSON.parse(prev.outputJson) as T, runId: prev.id, reused: true }; } catch { /* unreadable: run it again */ }
    }
  }
  if (rc.deadline != null && rc.deadline - Date.now() < STEP_MIN_START_MS[step]) throw new WriterPausedError(step);
  const run = await runAiJson<T>({
    kind, engine: "writer", effort: STEP_EFFORT[step], enrollmentId: rc.enrollmentId, clientId: rc.clientId, scope: { ...rc.scope, writerStep: step }, inputRefs: { ...(rc.inputRefs ?? {}), writerVersion: WRITER_VERSION },
    promptKey: `writer-${step}`, promptVersion: WRITER_VERSION, policyVersionId: rc.policyVersionId, strategyVersionId: rc.strategyVersionId, requestedBy: rc.requestedBy, unattended: rc.unattended,
    dedupeKey: opts.dedupeKey ?? null, holdDedupeKey: opts.holdDedupeKey, claimedRun: opts.claimedRun ?? null,
    system: prompt.system, prompt: prompt.prompt, schema: prompt.schema, maxTokens: STEP_MAX_TOKENS[step], timeoutMs: timeoutBefore(rc.deadline, STEP_MAX_TOKENS[step]),
  });
  return { output: run.output, runId: run.runId, reused: false };
}

// ---------------------------------------------------------------------------
// Retrieval → passages (code checks every quote against the source)
// ---------------------------------------------------------------------------

type RetrievalOut = { passages: { sourceId?: string; speaker?: string; kind?: string; quote?: string; forViewer?: boolean; reason?: string; why?: string }[]; overview?: string };
const MAX_PASSAGES = 14;

/** The model's passages, kept only when the quote is really in that source; context added by code; held back by rule or by the model's own reason. */
export async function passagesFrom(g: Pick<Gathered, "sources" | "lines" | "holdBack">, out: RetrievalOut): Promise<{ kept: WriterPassage[]; excluded: { quote: string; source: string; reason: string }[]; notFound: number }> {
  const rank = (id: string) => (id.startsWith("c") ? 0 : id.startsWith("o") ? 1 : 2);
  const kept: (WriterPassage & { r: number; first: number })[] = [];
  const excluded: { quote: string; source: string; reason: string }[] = [];
  const taken: { id: string; first: number; last: number }[] = [];
  let notFound = 0;
  for (const p of Array.isArray(out?.passages) ? out.passages : []) {
    const sid = String(p?.sourceId ?? "").trim();
    const lines = g.lines.get(sid);
    const doc = g.sources.find((s) => s.id === sid);
    const quote = String(p?.quote ?? "").replace(/\s+/g, " ").trim();
    if (!lines || !doc || !quote) { notFound++; continue; }
    const range = locateQuote(lines, quote);
    if (!range) { notFound++; continue; }
    const source = doc.label.replace(/\s*\(.*$/, "");
    if (p.forViewer === false) { excluded.push({ quote: quote.slice(0, 300), source, reason: String(p.reason ?? "").trim() || "not for a viewer" }); continue; }
    if (p.speaker && p.speaker !== "client") { excluded.push({ quote: quote.slice(0, 300), source, reason: p.speaker === "us" ? "said by Realtour Pilot, not her" : "said by someone else, not her" }); continue; }
    if (isInternalTalk(quote)) { excluded.push({ quote: quote.slice(0, 300), source, reason: "internal talk about our work with her" }); continue; }
    if (await g.holdBack(quote)) { excluded.push({ quote: "(held back)", source, reason: "confidential, or names another client" }); continue; }
    if (taken.some((t) => t.id === sid && range.first <= t.last && range.last >= t.first)) continue; // the same lines twice
    taken.push({ id: sid, ...range });
    kept.push({ id: "", source, time: timeOf(lines, range), speaker: "client", kind: String(p.kind ?? "experience"), quote: quote.slice(0, 700), context: contextAround(lines, range), why: String(p.why ?? "").trim().slice(0, 200), r: rank(sid), first: range.first });
  }
  kept.sort((a, b) => a.r - b.r || a.first - b.first);
  const passages = kept.slice(0, MAX_PASSAGES).map((p, i): WriterPassage => ({ id: `P${i + 1}`, source: p.source, time: p.time, speaker: p.speaker, kind: p.kind, quote: p.quote, context: p.context, why: p.why }));
  return { kept: passages, excluded: excluded.slice(0, 20), notFound };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

type BriefOut = Partial<Omit<TopicBrief, "whatSheSaid" | "target">> & { whatSheSaid?: string[] };
const s400 = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 600) : "");
const items = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => ({ text: s400((x as { text?: unknown })?.text), source: s400((x as { source?: unknown })?.source) || "unstated" })).filter((x) => x.text).slice(0, 14);

export function briefFrom(out: BriefOut, passages: WriterPassage[]): TopicBrief {
  const said = (Array.isArray(out.whatSheSaid) ? out.whatSheSaid : []).map((id) => passages.find((p) => p.id === String(id).trim())).filter((p): p is WriterPassage => !!p);
  return {
    centralMessage: s400(out.centralMessage), viewer: s400(out.viewer), whyChosen: s400(out.whyChosen), pillar: s400(out.pillar),
    whatSheSaid: [...new Set(said)].slice(0, 8).map((p) => ({ passageId: p.id, quote: p.quote, source: p.source, time: p.time })),
    mustKeep: items(out.mustKeep), optional: items(out.optional),
    excluded: (Array.isArray(out.excluded) ? out.excluded : []).map((x) => ({ text: s400((x as { text?: unknown }).text), reason: s400((x as { reason?: unknown }).reason) })).filter((x) => x.text).slice(0, 14),
    contradictions: (Array.isArray(out.contradictions) ? out.contradictions : []).map((x) => ({ text: s400((x as { text?: unknown }).text), sources: s400((x as { sources?: unknown }).sources) })).filter((x) => x.text).slice(0, 8),
    verifiedFacts: items(out.verifiedFacts), opinions: items(out.opinions), creativeIdeas: items(out.creativeIdeas), ourAssumptions: items(out.ourAssumptions),
    closeType: out.closeType === "callback" ? "callback" : "cta", closeWhy: s400(out.closeWhy),
    target: { aim: [WRITER_LENGTH.aim[0], WRITER_LENGTH.aim[1]], cap: WRITER_LENGTH.cap, seconds: [estimateSeconds(WRITER_LENGTH.aim[0]), estimateSeconds(WRITER_LENGTH.aim[1])] },
  };
}

// ---------------------------------------------------------------------------
// Prepare: gather → retrieval → brief → hooks
// ---------------------------------------------------------------------------

export type Prepared = {
  g: Gathered;
  passages: WriterPassage[];
  excluded: { quote: string; source: string; reason: string }[];
  overview: string | null;
  brief: TopicBrief;
  hooks: HookCandidate[];
  chosen: number;
  runs: { retrieval: string | null; brief: string | null; hooks: string | null };
};

export async function prepareDraft(o: GatherOpts & { requestedBy: string; unattended: boolean; deadline?: number | null; offline?: boolean }): Promise<Prepared> {
  const g = await gatherForTopic(o);
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: { topicId: o.topicId, monthId: o.monthId, ...(o.offline ? { offline: true, asOf: o.asOf?.toISOString() ?? null } : {}) }, enrollmentId: g.enrollmentId, clientId: g.clientId, strategyVersionId: g.strategyVersionId, policyVersionId: g.policyVersionId, inputRefs: g.inputRefs };
  const key = (step: string) => `writer:${o.offline ? "offline:" : ""}${step}:${o.topicId}:${o.monthId ?? "bank"}`;
  let passages: WriterPassage[] = [];
  let excluded: Prepared["excluded"] = [];
  let overview: string | null = null;
  let retrievalRun: string | null = null;
  if (g.sources.length) {
    const r = await runWriterStep<RetrievalOut>("retrieval", buildRetrievalPrompt(g.ctx, g.sources), rc, { dedupeKey: key("retrieval") });
    const got = await passagesFrom(g, r.output);
    passages = got.kept;
    excluded = got.excluded;
    overview = s400(r.output?.overview) || null;
    retrievalRun = r.runId;
  }
  const b = await runWriterStep<BriefOut>("brief", buildBriefPrompt(g.ctx, passages, excluded, overview), rc, { dedupeKey: key("brief") });
  const brief = briefFrom(b.output, passages);
  const h = await runWriterStep<{ hooks?: Parameters<typeof pickHook>[0] }>("hooks", buildHooksPrompt(g.ctx, brief), rc, { dedupeKey: key("hooks") });
  const picked = pickHook(h.output?.hooks ?? []);
  return { g, passages, excluded, overview, brief, hooks: picked.hooks, chosen: picked.chosen, runs: { retrieval: retrievalRun, brief: b.runId, hooks: h.runId } };
}

/** The draft call (the run a queued click adopts, holding the script's dedupe key until the version is written). */
export async function runDraftStep(p: Prepared, o: { requestedBy: string; unattended: boolean; deadline?: number | null; claimedRun?: ClaimedRun | null; dedupeKey: string; scope: Record<string, unknown> }) {
  const chosen = p.chosen >= 0 ? p.hooks[p.chosen] : null;
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: o.scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, inputRefs: { ...p.g.inputRefs, passages: p.passages.length, briefRunId: p.runs.brief, hooksRunId: p.runs.hooks } };
  return runWriterStep<DraftOut>("draft", buildDraftPrompt(p.g.ctx, p.brief, p.passages, chosen ? { text: chosen.text, rehook: chosen.rehook } : null), rc, { dedupeKey: o.dedupeKey, holdDedupeKey: true, claimedRun: o.claimedRun ?? null, reuse: false });
}

/** The writer's answer in the shape every version is written from (contentGeneration.partsFromGenerated). The winning hook is put back word for word. */
export function generatedFromDraft(out: DraftOut, chosenHook: string | null, category: string): GeneratedScriptJson {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const gaps: Gap[] = (Array.isArray(out?.gaps) ? out.gaps : []).filter((x) => x && s(x.text)).map((x) => ({ kind: (["unsupported-claim", "missing-answer", "missing-source", "unverified-history", "insufficient-context", "placeholder"].includes(x.kind) ? x.kind : "insufficient-context") as Gap["kind"], field: null, text: s(x.text), question: s(x.question) || null }));
  return {
    angle: null,
    title: s(out?.title), category,
    hook: chosenHook?.trim() || s(out?.hook),
    points: [{ role: "re-hook", text: s(out?.rehook) }, { role: "build-up", text: s(out?.buildup) }, { role: "payoff", text: s(out?.payoff) }],
    close: s(out?.close), captionCta: s(out?.captionCta) || null, filmingNotes: s(out?.filmingNotes) || null,
    contentPillarCheck: null, sourceExcerpts: (Array.isArray(out?.sourcesUsed) ? out.sourcesUsed : []).map(s).filter(Boolean).slice(0, 20), gaps,
  };
}

export function rationaleOf(out: DraftOut | null | undefined): WriterRationale | null {
  const r = out?.rationale;
  if (!r) return null;
  const s = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 400) : "");
  const x = { hook: s(r.hook), takeaway: s(r.takeaway), strategy: s(r.strategy) };
  return x.hook || x.takeaway || x.strategy ? x : null;
}

/** What is stored with the version (validationJson.writer). */
export function writerRecordOf(p: Prepared, draft: { output: DraftOut; runId: string }, asOf: Date | null = null): WriterRecord {
  return {
    v: 2, version: WRITER_VERSION, brief: p.brief, passages: p.passages, excludedPassages: p.excluded, hooks: p.hooks, chosen: p.chosen, rationale: rationaleOf(draft.output),
    facts: p.g.ctx.facts, sources: p.g.labels, runs: { retrieval: p.runs.retrieval, brief: p.runs.brief, hooks: p.runs.hooks, draft: draft.runId }, asOf: asOf?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Review (the 12 checks + the hard numbers)
// ---------------------------------------------------------------------------

type ReviewOut = { checks?: { key?: string; pass?: boolean; reason?: string }[]; fixInstruction?: string; summary?: string };
export type ReviewResult = { checks: ReviewCheckResult[]; hard: HardFinding[]; mustFails: ReviewCheckResult[]; fixInstruction: string | null; summary: string | null; words: number; seconds: number; runId: string };

/** What she said or approved, as the hard numbers read it (never our assumptions). */
export function clientTextOf(rec: Pick<WriterRecord, "passages" | "facts">, ctx: Pick<WriterContext, "answers" | "strategyText" | "relatedScripts">): string {
  return [...rec.passages.flatMap((p) => [p.quote, p.context]), ...rec.facts.map((f) => f.body), ...ctx.answers.map((a) => a.answer), ...ctx.relatedScripts.map((r) => r.text), ctx.strategyText ?? ""].join("\n");
}

export async function reviewParts(ctx: WriterContext, rec: WriterRecord, parts: ScriptParts & { closeType?: string | null }, rc: RunCtx, opts: { dedupeKey?: string | null } = {}): Promise<ReviewResult> {
  const numbers = hardNumbers(parts, clientTextOf(rec, ctx));
  const body = [`HOOK: ${parts.hook}`, ...parts.points.map((p, i) => `${["RE-HOOK", "BUILD-UP", "PAYOFF"][i] ?? "POINT"}: ${p.text}`), `CLOSE: ${parts.close}`].join("\n");
  const prompt = buildReviewPrompt({ ...ctx, facts: rec.facts }, rec.brief, rec.passages, { body, closeType: parts.closeType ?? null }, { words: numbers.words, seconds: numbers.seconds, hookWords: numbers.hookWords, hard: numbers.findings.map((f) => f.detail) });
  // Every version gets its own review run (never a reused verdict): the ledger shows each check.
  const r = await runWriterStep<ReviewOut>("review", prompt, rc, { dedupeKey: opts.dedupeKey ?? null, reuse: false });
  const checks = mergeReview(Array.isArray(r.output?.checks) ? r.output.checks : [], numbers.findings, numbers.words);
  const mustFails = mustFixFailures(checks);
  const fix = typeof r.output?.fixInstruction === "string" ? r.output.fixInstruction.trim().slice(0, 3000) : "";
  return { checks, hard: numbers.findings, mustFails, fixInstruction: checks.some((c) => !c.pass) ? fix || null : null, summary: s400(r.output?.summary) || null, words: numbers.words, seconds: numbers.seconds, runId: r.runId };
}

/**
 * After a review, what happens next (the automatic check and the offline run
 * share this order):
 *   nothing must-fix fails            → pass (flags stay on the card)
 *   only the length fails, no trim yet → the trim pass
 *   fix rounds left (two at most)      → a fix round (it trims too when over)
 *   still over the cap, no trim yet    → the trim pass
 *   otherwise                          → flagged for Jordan, never quietly passed
 */
export function nextWriterStep(o: { mustFails: ReviewCheckResult[]; words: number; fixRounds: number; trimmed: boolean; maxFixRounds?: number }): "pass" | "trim" | "fix" | "flag" {
  if (!o.mustFails.length) return "pass";
  if (o.mustFails.every((c) => c.key === "length") && !o.trimmed) return "trim";
  if (o.fixRounds < (o.maxFixRounds ?? 2)) return "fix";
  if (o.words > WRITER_LENGTH.cap && !o.trimmed) return "trim";
  return "flag";
}

/** What a fix round is told: every failing check (must-fix first), the reviewer's instruction, the trim when over the cap, and no invention. */
export function writerFixInstruction(j: { checks?: ReviewCheckResult[]; hard?: HardFinding[]; fixInstruction?: string | null; words?: number }): string {
  const checks = j.checks ?? [];
  const must = checks.filter((c) => !c.pass && c.level === "must-fix");
  const flags = checks.filter((c) => !c.pass && c.level === "flag");
  return [
    "The independent creative review found problems with this version. Fix these and keep every line that passed word for word where you can.",
    must.length ? `MUST FIX:\n${must.map((c) => `- ${c.n}. ${c.label}: ${c.reason}`).join("\n")}` : "",
    flags.length ? `ALSO IMPROVE IF YOU CAN WITHOUT LOSING ANYTHING:\n${flags.map((c) => `- ${c.n}. ${c.label}: ${c.reason}`).join("\n")}` : "",
    j.fixInstruction ? `THE REVIEWER'S INSTRUCTION: ${j.fixInstruction}` : "",
    (j.words ?? 0) > WRITER_LENGTH.cap ? trimInstruction(j.words ?? 0) : "",
    "Use only her sources. Anything they do not support stays a gap: never invent a story, number, result, reason or credential to fix a problem.",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// The record a version carries, found on it or on the newest version before it
// ---------------------------------------------------------------------------

export async function latestWriterRecord(scriptId: string, preferVersionId?: string | null): Promise<WriterRecord | null> {
  if (preferVersionId) {
    const v = await prisma.contentScriptVersion.findUnique({ where: { id: preferVersionId }, select: { validationJson: true } });
    const w = readWriter(v?.validationJson);
    if (w) return w;
  }
  const vs = await prisma.contentScriptVersion.findMany({ where: { scriptId, validationJson: { contains: '"writer":{"v":2' } }, orderBy: { versionNo: "desc" }, take: 1, select: { validationJson: true } });
  return readWriter(vs[0]?.validationJson);
}

/** The context for a review or a revision of a script the writer drafted (no transcript reading: the record carries the passages). */
export async function contextForScript(s: { topicId: string | null; monthId: string | null; id: string }, rec: WriterRecord): Promise<{ ctx: WriterContext }> {
  if (!s.topicId) throw new Error("This script has no topic, so the new writer cannot rebuild its context.");
  const g = await gatherForTopic({ topicId: s.topicId, monthId: s.monthId, excludeScriptId: s.id, light: true, asOf: rec.asOf ? new Date(rec.asOf) : null });
  // The facts the brief was built on, not whatever the file holds today.
  return { ctx: { ...g.ctx, facts: rec.facts } };
}

/** A version's parts as the review reads them. */
export function partsOfVersion(v: { hook: string; pointsJson: string; close: string }): ScriptParts {
  let points: { role: string | null; text: string }[] = [];
  try { points = (JSON.parse(v.pointsJson) as { role?: string | null; text?: string }[]).map((p) => ({ role: p.role ?? null, text: String(p.text ?? "") })); } catch { points = []; }
  return { hook: v.hook, points, close: v.close };
}

/** Review one stored version (the automatic check's v2 step). */
export async function reviewVersion(versionId: string, o: { requestedBy: string; unattended: boolean; deadline?: number | null }): Promise<ReviewResult & { closeType: string | null }> {
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("Version not found.");
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { id: true, topicId: true, monthId: true, enrollmentId: true, clientId: true } });
  if (!s) throw new Error("Script not found.");
  const rec = readWriter(v.validationJson) ?? (await latestWriterRecord(s.id));
  if (!rec) throw new Error("This version has no topic brief to review against.");
  const { ctx } = await contextForScript(s, rec);
  let closeType: string | null = null;
  try { closeType = (JSON.parse(v.validationJson ?? "{}") as { closeType?: string }).closeType ?? null; } catch { closeType = null; }
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: { scriptId: s.id, versionId }, enrollmentId: s.enrollmentId, clientId: s.clientId, strategyVersionId: v.strategyVersionId, policyVersionId: v.policyVersionId, inputRefs: { versionId, briefRunId: rec.runs.brief } };
  const r = await reviewParts(ctx, rec, { ...partsOfVersion(v), closeType: closeType ?? rec.brief.closeType }, rc, { dedupeKey: `review:${versionId}` });
  return { ...r, closeType };
}

/** The revise prompt for a script the writer drafted (fix rounds, the trim pass, a person's or a client's request). */
export async function writerRevisePrompt(s: { id: string; topicId: string | null; monthId: string | null }, rec: WriterRecord, current: { versionNo: number; body: string }, instruction: string, opts: { lockedLabels?: string[]; who: "review" | "trim" | "person" | "client" }): Promise<StepPrompt> {
  const { ctx } = await contextForScript(s, rec);
  return buildReviseWriterPrompt(ctx, rec.brief, rec.passages, current, instruction, opts);
}

// ---------------------------------------------------------------------------
// PHASE 3's OFFLINE RUN: the whole pipeline on one topic, as of a moment in
// the past, with nothing written but the AI run rows (scope offline: true).
// No script, no version, no portal, no message. For the go / no-go test.
// ---------------------------------------------------------------------------

export type OfflineAttempt = { label: string; parts: ScriptParts; closeType: string | null; words: number; seconds: number; review: ReviewResult | null };

export async function draftOffline(o: { topicId: string; monthId: string | null; asOf?: Date | null; requestedBy: string; callRecordId?: string | null }): Promise<{ prepared: Omit<Prepared, "g">; record: WriterRecord; attempts: OfflineAttempt[]; final: OfflineAttempt; state: "passed" | "flagged" }> {
  const p = await prepareDraft({ topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null, asOf: o.asOf ?? null, requestedBy: o.requestedBy, unattended: false, offline: true });
  const scope = { topicId: o.topicId, monthId: o.monthId, offline: true, asOf: o.asOf?.toISOString() ?? null };
  const draft = await runWriterStep<DraftOut>("draft", buildDraftPrompt(p.g.ctx, p.brief, p.passages, p.chosen >= 0 ? { text: p.hooks[p.chosen].text, rehook: p.hooks[p.chosen].rehook } : null), { requestedBy: o.requestedBy, unattended: false, scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, inputRefs: p.g.inputRefs });
  const rec = writerRecordOf(p, draft, o.asOf ?? null);
  const toParts = (out: DraftOut, hook: string | null) => { const j = generatedFromDraft(out, hook, p.g.ctx.topic.pillar); return { parts: { hook: j.hook, points: j.points.map((x) => ({ role: String(x.role), text: x.text })), close: j.close } as ScriptParts, closeType: out?.closeType ?? null }; };
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: false, scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId };
  const attempts: OfflineAttempt[] = [];
  let cur = toParts(draft.output, p.chosen >= 0 ? p.hooks[p.chosen].text : null);
  let fixRounds = 0, trimmed = false, label = "draft";
  for (let guard = 0; guard < 5; guard++) {
    const review = await reviewParts(p.g.ctx, rec, { ...cur.parts, closeType: cur.closeType }, rc);
    attempts.push({ label, parts: cur.parts, closeType: cur.closeType, words: review.words, seconds: review.seconds, review });
    if (!review.mustFails.length) return { prepared: strip(p), record: rec, attempts, final: attempts[attempts.length - 1], state: "passed" };
    // The same order as the automatic check on the version trail (scriptJudge.ts).
    const next = nextWriterStep({ mustFails: review.mustFails, words: review.words, fixRounds, trimmed });
    if (next === "flag") break;
    let instruction: string, who: "review" | "trim";
    if (next === "trim") { instruction = trimInstruction(review.words); who = "trim"; trimmed = true; label = "trim"; }
    else { instruction = writerFixInstruction({ checks: review.checks, hard: review.hard, fixInstruction: review.fixInstruction, words: review.words }); who = "review"; fixRounds++; label = `fix ${fixRounds}`; }
    const body = spokenTextOf(cur.parts);
    const step = buildReviseWriterPrompt(p.g.ctx, p.brief, p.passages, { versionNo: attempts.length, body }, instruction, { who });
    const revised = await runWriterStep<DraftOut>("revise", step, rc);
    cur = toParts(revised.output, null);
  }
  const best = attempts.reduce((a, b) => (score(b) < score(a) ? b : a), attempts[0]);
  return { prepared: strip(p), record: rec, attempts, final: best, state: "flagged" };
}

const score = (a: OfflineAttempt) => (a.review ? a.review.mustFails.length * 100 + a.review.checks.filter((c) => !c.pass).length : 999);
const strip = (p: Prepared): Omit<Prepared, "g"> => { const { g: _g, ...rest } = p; void _g; return rest; };
