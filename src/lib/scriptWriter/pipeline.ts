import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson, sha256, type AiRunKind, type ClaimedRun } from "@/lib/aiRuns";
import { timeoutBefore, type AiEffort } from "@/lib/integrations/ai";
import type { GeneratedScriptJson, Gap } from "@/lib/contentPolicy";
import { gatherForTopic, withHerWords, type Gathered, type GatherOpts } from "./sources";
import { buildRetrievalPrompt, buildBriefPrompt, buildHooksPrompt, buildDraftPrompt, buildReviewPrompt, buildReviseWriterPrompt, buildRedraftPrompt, type DraftOut, type StepPrompt, type WriterContext } from "./prompts";
import { locateQuote, contextAround, timeOf, isInternalTalk } from "./passages";
import { pickHook, hardNumbers, mergeReview, mustFixFailures, trimInstruction, spokenTextOf, runnerUpHook, hookInUse, hookVerdict, hookIsBarPick, hookRank, readCraft, keptLongerConflicts, pickFinal, usedStory, partTextOf, trimAboveFor, agreedFormatOf, WRITER_LENGTH, WRITER_VERSION, BRIEF_MUST_KEEP_MAX, CRAFT_FAIL_AT, CRAFT_PASS, CRAFT_PARTS, SCRIPT_PART_KEYS, CHECK_PARTS, estimateSeconds, type CraftScores, type HookCandidate, type ReviewCheckResult, type HardFinding, type ScriptParts, type ScriptPartKey } from "./rules";
import { countSpokenWords } from "../contentPolicy/policy";
import { readWriter, type TopicBrief, type WriterPassage, type WriterRecord, type WriterRationale } from "./record";

// ---------------------------------------------------------------------------
// THE NEW SCRIPT WRITER (Oct 22 2026): phases 1 and 2 of the approved plan.
//
//   gather      sources.ts: the topic's call in full, older call windows, her
//               facts (unreviewed client-spoken ones too), same-subject scripts,
//               voice examples, why the topic was chosen                (no AI)
//   retrieval   every passage where she talks about the topic, verbatim, found
//               in the source by code with the lines around it; internal talk
//               held back                          (claude-haiku-5-5, medium)
//   brief       the topic brief                    (claude-sonnet-5-5, medium)
//   hooks       five hooks with re-hooks, scored; code keeps the best
//                                                  (claude-opus-5-5, high)
//   draft       the five-part script; the winning hook word for word
//                                                  (claude-sonnet-5-5, high)
//   review      the independent creative review: 12 checks, the craft block
//               (v2.3) + code's hard numbers; up to two fix rounds (v2.5: a
//               third when Enough substance is the only must-fix left) and one
//               trim pass; a script that still fails a must-fix arrives
//               FLAGGED (scriptJudge.ts runs this loop on the version trail)
//                                                  (claude-sonnet-5-5, medium)
//   (v2.3, STEP_MODEL: until then every step ran on claude-opus-5-5. Fixes,
//   trims and revisions: claude-sonnet-5-5, high. The long stable part of each
//   prompt sits in front of a cache breakpoint, so a second review or fix
//   round reads it from the cache.)
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
/**
 * THE MODEL MAP (Oct 22 2026, writer v2.3; Jordan: "$18 for scripts is
 * insane. Change the model so it doesn't cost me so much. Make sure it's
 * still a good model for this though."). Measured on 16 offline scripts, all
 * on Opus 5.5: $19.49, about $1.22 a script (review $5.46, draft $3.40, brief
 * $3.31, retrieval $3.30, revise $2.93, hooks $1.09). Now:
 *   hooks      Opus 5.5, high: the most important creative step, and cheap
 *   draft      Sonnet 5.5, high      revise   Sonnet 5.5, high
 *   brief      Sonnet 5.5, medium    review   Sonnet 5.5, medium
 *   retrieval  Haiku 5.5, medium: finding her passages in a long transcript
 * Exact ids, no date suffix; every effort named (Sonnet 5.5 defaults to high,
 * Haiku 5.5 to medium, and the levels differ by model). The model is stamped
 * on every ProgramAiRun (the answering model, as before).
 */
export const STEP_MODEL: Record<Step, string> = { retrieval: "claude-haiku-5-5", brief: "claude-sonnet-5-5", hooks: "claude-opus-5-5", draft: "claude-sonnet-5-5", review: "claude-sonnet-5-5", revise: "claude-sonnet-5-5" };
/** The effort per step (v2.3, with STEP_MODEL): high for the hooks, the draft and every revision; medium for reading the sources, the brief and the review. */
export const STEP_EFFORT: Record<Step, AiEffort> = { retrieval: "medium", brief: "medium", hooks: "high", draft: "high", review: "medium", revise: "high" };
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
    kind, engine: "writer", model: STEP_MODEL[step], effort: STEP_EFFORT[step], enrollmentId: rc.enrollmentId, clientId: rc.clientId, scope: { ...rc.scope, writerStep: step }, inputRefs: { ...(rc.inputRefs ?? {}), writerVersion: WRITER_VERSION },
    promptKey: `writer-${step}`, promptVersion: WRITER_VERSION, policyVersionId: rc.policyVersionId, strategyVersionId: rc.strategyVersionId, requestedBy: rc.requestedBy, unattended: rc.unattended,
    dedupeKey: opts.dedupeKey ?? null, holdDedupeKey: opts.holdDedupeKey, claimedRun: opts.claimedRun ?? null,
    system: prompt.system, prompt: prompt.prompt, promptBlocks: prompt.blocks ?? null, schema: prompt.schema, maxTokens: STEP_MAX_TOKENS[step], timeoutMs: timeoutBefore(rc.deadline, STEP_MAX_TOKENS[step]),
  });
  return { output: run.output, runId: run.runId, reused: false };
}

// ---------------------------------------------------------------------------
// Retrieval → passages (code checks every quote against the source)
// ---------------------------------------------------------------------------

type RetrievalOut = { passages: { sourceId?: string; speaker?: string; kind?: string; quote?: string; forViewer?: boolean; reason?: string; why?: string }[]; overview?: string };
const MAX_PASSAGES = 14;
/** Room kept for her older calls among the passages (Oct 22 2026): a long topic call no longer crowds them all out. */
const OLDER_PASSAGES_MAX = 4;
/** The interviewer's lines on the topic the brief is shown (Oct 22 2026). */
const ASKED_MAX = 3;

export type AskedLine = { quote: string; source: string; time: string | null };

/**
 * The model's passages, kept only when the quote is really in that source; context added by code; held back by rule or by the model's own reason.
 * Oct 22 2026 (the listening fix): staff lines found on the topic's call are also returned as `asked` (the
 * interviewer's question, which says what the video is for; never her words, never script material), and up
 * to OLDER_PASSAGES_MAX passages from her older calls keep their place.
 */
export async function passagesFrom(g: Pick<Gathered, "sources" | "lines" | "holdBack">, out: RetrievalOut): Promise<{ kept: WriterPassage[]; excluded: { quote: string; source: string; reason: string }[]; notFound: number; asked: AskedLine[] }> {
  const rank = (id: string) => (id.startsWith("c") ? 0 : id.startsWith("o") ? 1 : 2);
  const kept: (WriterPassage & { r: number; first: number })[] = [];
  const excluded: { quote: string; source: string; reason: string }[] = [];
  const taken: { id: string; first: number; last: number }[] = [];
  const asked: AskedLine[] = [];
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
    if (p.speaker === "us" && doc.kind === "call" && asked.length < ASKED_MAX && !isInternalTalk(quote) && !(await g.holdBack(quote))) asked.push({ quote: quote.slice(0, 400), source, time: timeOf(lines, range) });
    if (p.forViewer === false) { excluded.push({ quote: quote.slice(0, 300), source, reason: String(p.reason ?? "").trim() || "not for a viewer" }); continue; }
    if (p.speaker && p.speaker !== "client") { excluded.push({ quote: quote.slice(0, 300), source, reason: p.speaker === "us" ? "said by Realtour Pilot, not her" : "said by someone else, not her" }); continue; }
    if (isInternalTalk(quote)) { excluded.push({ quote: quote.slice(0, 300), source, reason: "internal talk about our work with her" }); continue; }
    if (await g.holdBack(quote)) { excluded.push({ quote: "(held back)", source, reason: "confidential, or names another client" }); continue; }
    if (taken.some((t) => t.id === sid && range.first <= t.last && range.last >= t.first)) continue; // the same lines twice
    taken.push({ id: sid, ...range });
    kept.push({ id: "", source, time: timeOf(lines, range), speaker: "client", kind: String(p.kind ?? "experience"), quote: quote.slice(0, 700), context: contextAround(lines, range), why: String(p.why ?? "").trim().slice(0, 200), r: rank(sid), first: range.first });
  }
  kept.sort((a, b) => a.r - b.r || a.first - b.first);
  const older = kept.filter((p) => p.r === 1).slice(0, OLDER_PASSAGES_MAX);
  const calls = kept.filter((p) => p.r === 0).slice(0, MAX_PASSAGES - older.length);
  const rest = kept.filter((p) => p.r === 2).slice(0, Math.max(0, MAX_PASSAGES - older.length - calls.length));
  const passages = [...calls, ...older, ...rest].map((p, i): WriterPassage => ({ id: `P${i + 1}`, source: p.source, time: p.time, speaker: p.speaker, kind: p.kind, quote: p.quote, context: p.context, why: p.why }));
  return { kept: passages, excluded: excluded.slice(0, 20), notFound, asked };
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

type BriefOut = Partial<Omit<TopicBrief, "whatSheSaid" | "target" | "mustKeep" | "proof">> & { whatSheSaid?: string[]; mustKeep?: { text?: unknown; source?: unknown; inProgress?: unknown }[]; proof?: { text?: unknown; source?: unknown; isHerStory?: unknown } | null };
const s400 = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 600) : "");
const items = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => ({ text: s400((x as { text?: unknown })?.text), source: s400((x as { source?: unknown })?.source) || "unstated" })).filter((x) => x.text).slice(0, 14);

/** v2.3: a must-keep point that is the invitation (it belongs to the close, never must-keep). */
export const INVITATION_RE = /\b(?:let'?s talk|reach out|call me|contact (?:me|her)|get in touch|message me|dm me|the invitation|an invitation|invite (?:the viewer|viewers|them|you) to)\b/i;
/** v2.3: the interviewer asking for an example; her answer is the proof, so the question stays in whatWeAsked. */
export const EXAMPLE_ASK_RE = /\b(?:have you ever|has (?:there|that) ever|a real example|an example|for example|give me an example|what was the outcome|how did (?:it|that) (?:end|turn out|go)|tell me about a time|what happened)\b/i;

/**
 * v2.4: a passage about a deal still in progress (Marcee's 2022 draft used a
 * listing her buyer "just wrote an offer on"). Read on the proof's own
 * passages (her quote), never on the lines around them.
 */
export const LIVE_DEAL_RE = /\b(?:just wrote an offer|made an offer|on the market for over|currently|under contract now)\b/i;

/**
 * The passages a brief's proof cites: by id (P3), or by the time it names ("call at 01:26:08"). Pure.
 * v2.5: by id only when it names ids. Two passages from one block of the call share a time (Marcee's
 * 2022: P4, her "even playing field" message, and P5, the live deal, both 01:24:42), so a time beside
 * the ids took the message out with the deal.
 */
export function proofPassages(proof: { source?: string | null } | null | undefined, passages: readonly WriterPassage[]): WriterPassage[] {
  const src = proof?.source ?? "";
  const ids = new Set(src.match(/\bP\d+\b/g) ?? []);
  const times = new Set(src.match(/\b\d{1,2}:\d{2}:\d{2}\b/g) ?? []);
  if (ids.size) return passages.filter((p) => ids.has(p.id));
  return passages.filter((p) => !!p.time && times.has(p.time));
}

/**
 * v2.4 (unsafe or used proofs, pure): why the brief's proof cannot be this
 * video's proof, or null. A live deal on its passage (LIVE_DEAL_RE), or a
 * story she already told in an approved or filmed script (rules.usedStory).
 */
export function proofProblem(proof: { text: string; source?: string | null } | null, passages: readonly WriterPassage[], onCamera: readonly { title: string; text: string }[] = []): { kind: "live" | "used"; reason: string; ids: string[]; figures: string[] } | null {
  if (!proof?.text) return null;
  const own = proofPassages(proof, passages);
  const ids = own.map((p) => p.id);
  const live = own.find((p) => LIVE_DEAL_RE.test(p.quote));
  // v2.5: never in the script (it said "at most a mention in general terms", and the 2022 draft was built on it).
  if (live) return { kind: "live", ids, figures: [], reason: `a deal still in progress (${live.id}: "${(LIVE_DEAL_RE.exec(live.quote)?.[0] ?? "").trim()}"): never in the script` };
  const used = usedStory([proof.text, ...own.map((p) => p.quote)].join("\n"), onCamera);
  if (used) return { kind: "used", ids, figures: used.figures, reason: `a story she has already told on camera ("${used.title}": ${used.figures.join(", ")}; ${used.words.slice(0, 5).join(", ")}): never this video's proof` };
  return null;
}

/**
 * The brief as stored. Oct 22 2026 (the listening fix), held by code whatever
 * the model wrote: a point about a deal still in progress is never must-keep
 * (it goes to excluded); an educational video keeps at most three must-keep
 * points (v2.3; it was four) and a story six, the rest moved to the front of
 * optional. A brief without a video type is read as educational. v2.3: the
 * invitation is never must-keep (moved to optional); when the interviewer
 * asked for an example and whatWeAsked lost that question, code puts it back.
 * v2.4: a proof whose passage is a live deal, or a story she already told on
 * camera (`onCamera`: her approved or filmed scripts), is moved to excluded
 * (isHerStory cleared), with every must-keep point that cites its passages or
 * carries its figures; a told story's target is WRITER_LENGTH.storyTarget.
 * v2.5 (the live deal leaked: Marcee's 2022 proof was emptied, but the deal
 * stayed in verifiedFacts and her passage P5 stayed quoted, and the hook,
 * re-hook and build-up were built on it): a LIVE proof's passages leave what
 * she said, and every verified fact, optional point, opinion, phrase,
 * creative idea, assumption and contradiction that cites them or tells the
 * same story goes too. Excluded names the deal by its passages, without its
 * details ("never in the script"); its words are kept for code only
 * (heldBack: pickHook, live_deal, the writer's passages).
 */
export function briefFrom(out: BriefOut, passages: WriterPassage[], asked: readonly { quote: string; time: string | null }[] = [], opts: { onCamera?: readonly { title: string; text: string }[] } = {}): TopicBrief {
  const said0 = (Array.isArray(out.whatSheSaid) ? out.whatSheSaid : []).map((id) => passages.find((p) => p.id === String(id).trim())).filter((p): p is WriterPassage => !!p);
  const videoType = out.videoType === "story" ? "story" : "educational";
  const rawKeep = Array.isArray(out.mustKeep) ? out.mustKeep : [];
  const live = items(rawKeep.filter((m) => m?.inProgress === true));
  const notLive0 = items(rawKeep.filter((m) => m?.inProgress !== true));
  const proofText0 = s400(out.proof?.text);
  const proofSource0 = s400(out.proof?.source);
  const problem = proofText0 ? proofProblem({ text: proofText0, source: proofSource0 }, passages, opts.onCamera ?? []) : null;
  const citesProof = (source: string) => !!problem && (source.match(/\bP\d+\b/g) ?? []).some((id) => problem.ids.includes(id));
  const tellsProof = (text: string) => !!problem && usedStory(text, [{ title: "", text: proofText0 }]) !== null;
  // The must-keep points that are the same proof: they cite its passages, or tell the same story (a figure and three words of it).
  const sameProof = (m: { text: string; source: string }) => citesProof(m.source) || tellsProof(m.text);
  // v2.5: a live deal leaves every list the writer and the hooks step read.
  const liveProof = problem?.kind === "live" ? problem : null;
  const keepOut = <T extends { text: string }>(xs: T[], sourceOf: (x: T) => string): T[] => (liveProof ? xs.filter((x) => !citesProof(sourceOf(x)) && !tellsProof(x.text)) : xs);
  const bySource = (x: { source: string }) => x.source;
  const said = liveProof ? said0.filter((p) => !liveProof.ids.includes(p.id)) : said0;
  const unsafeKeep = notLive0.filter(sameProof);
  const notLive = notLive0.filter((m) => !sameProof(m));
  const invites = notLive.filter((m) => INVITATION_RE.test(m.text));
  const keepAll = notLive.filter((m) => !INVITATION_RE.test(m.text));
  const cap = BRIEF_MUST_KEEP_MAX[videoType];
  const proofText = problem ? "" : proofText0;
  let whatWeAsked = s400(out.whatWeAsked);
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const a of asked) {
    if (!EXAMPLE_ASK_RE.test(a.quote) || flat(whatWeAsked).includes(flat(a.quote).slice(0, 60))) continue;
    whatWeAsked = `${whatWeAsked ? `${whatWeAsked} ` : ""}The interviewer asked for an example (her answer is the proof): "${a.quote.replace(/\s+/g, " ").trim().slice(0, 300)}"${a.time ? ` (${a.time})` : ""}.`.trim().slice(0, 1200);
  }
  // v2.5: what code keeps out, for code only: the excluded proof (with a live deal's passages' words) and the points marked in progress.
  const heldBack: NonNullable<TopicBrief["heldBack"]> = [
    ...(problem ? [{ kind: problem.kind, ids: problem.ids, text: [proofText0, ...unsafeKeep.map((m) => m.text), ...(liveProof ? proofPassages({ source: proofSource0 }, passages).map((p) => p.quote) : [])].join("\n").slice(0, 4000) }] : []),
    ...(live.length ? [{ kind: "live" as const, ids: [] as string[], text: live.map((m) => m.text).join("\n").slice(0, 2000) }] : []),
  ];
  return {
    videoType, whatWeAsked, angle: s400(out.angle), proof: proofText ? { text: proofText, source: s400(out.proof?.source) || "unstated", ...(out.proof?.isHerStory === true ? { isHerStory: true } : {}) } : null,
    centralMessage: s400(out.centralMessage), viewer: s400(out.viewer), whyChosen: s400(out.whyChosen), pillar: s400(out.pillar),
    whatSheSaid: [...new Set(said)].slice(0, 8).map((p) => ({ passageId: p.id, quote: p.quote, source: p.source, time: p.time })),
    mustKeep: keepAll.slice(0, cap), herPhrases: keepOut(items(out.herPhrases), bySource).slice(0, 5),
    optional: [
      ...keepAll.slice(cap).map((m) => ({ ...m, text: `${m.text} (moved from must-keep: ${videoType === "story" ? "a story keeps its main beats" : "the belief, the proof, how she helps"})` })),
      ...invites.map((m) => ({ ...m, text: `${m.text} (moved from must-keep: the invitation belongs to the close)` })),
      ...keepOut(items(out.optional), bySource),
    ].slice(0, 14),
    excluded: [
      // v2.4: the unsafe or used proof first, with the must-keep points that carried it.
      // v2.5: a live deal is named by its passages only: its details never reach the writer or the hooks step.
      ...(liveProof ? [{ text: `The deal in ${[...liveProof.ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(", ")} (her example; its details stay out)`, reason: liveProof.reason }] : []),
      ...(problem && !liveProof ? [{ text: `The proof: ${proofText0}`, reason: problem.reason }, ...unsafeKeep.map((m) => ({ text: m.text, reason: problem.reason }))] : []),
      ...live.map((m) => ({ text: m.text, reason: "a deal still in progress: never in the script" })),
      ...keepOut((Array.isArray(out.excluded) ? out.excluded : []).map((x) => ({ text: s400((x as { text?: unknown }).text), reason: s400((x as { reason?: unknown }).reason) })).filter((x) => x.text), (x) => x.text),
    ].slice(0, 14),
    contradictions: keepOut((Array.isArray(out.contradictions) ? out.contradictions : []).map((x) => ({ text: s400((x as { text?: unknown }).text), sources: s400((x as { sources?: unknown }).sources) })).filter((x) => x.text), (x) => x.sources).slice(0, 8),
    verifiedFacts: keepOut(items(out.verifiedFacts), bySource), opinions: keepOut(items(out.opinions), bySource), creativeIdeas: keepOut(items(out.creativeIdeas), bySource), ourAssumptions: keepOut(items(out.ourAssumptions), bySource),
    closeType: out.closeType === "callback" ? "callback" : "cta", closeWhy: s400(out.closeWhy),
    // v2.4: a told personal story may use up to the cap (Jordan's story finals run 94 to 110).
    target: videoType === "story"
      ? { aim: [WRITER_LENGTH.aim[0], WRITER_LENGTH.cap], cap: WRITER_LENGTH.cap, seconds: [estimateSeconds(WRITER_LENGTH.aim[0]), estimateSeconds(WRITER_LENGTH.cap)], words: WRITER_LENGTH.storyTarget }
      : { aim: [WRITER_LENGTH.aim[0], WRITER_LENGTH.aim[1]], cap: WRITER_LENGTH.cap, seconds: [estimateSeconds(WRITER_LENGTH.aim[0]), estimateSeconds(WRITER_LENGTH.aim[1])], words: WRITER_LENGTH.target },
    ...(heldBack.length ? { heldBack } : {}),
  };
}

/** v2.5: the live deals a brief keeps out, as one text (hardNumbers' live_deal), or null. Pure. */
export function liveDealOf(brief: Pick<TopicBrief, "heldBack"> | null | undefined): string | null {
  const t = (brief?.heldBack ?? []).filter((h) => h.kind === "live").map((h) => h.text).join("\n").trim();
  return t || null;
}

/**
 * v2.5: the brief's material other than what it keeps out (the angle, the
 * message, the must-keep, optional, facts, opinions, phrases and ideas), as
 * one text. Words in it belong to the topic, not to a held-back story
 * (rules.tellsHeldStory). Pure.
 */
export function keptTextOf(brief: Partial<Pick<TopicBrief, "angle" | "centralMessage" | "mustKeep" | "optional" | "verifiedFacts" | "opinions" | "herPhrases" | "creativeIdeas">> | null | undefined): string {
  if (!brief) return "";
  const xs = [...(brief.mustKeep ?? []), ...(brief.optional ?? []), ...(brief.verifiedFacts ?? []), ...(brief.opinions ?? []), ...(brief.herPhrases ?? []), ...(brief.creativeIdeas ?? [])];
  return [brief.angle ?? "", brief.centralMessage ?? "", ...xs.map((x) => x.text)].join("\n");
}

// ---------------------------------------------------------------------------
// Prepare: gather → retrieval → brief → hooks
// ---------------------------------------------------------------------------

export type Prepared = {
  g: Gathered;
  passages: WriterPassage[];
  excluded: { quote: string; source: string; reason: string }[];
  overview: string | null;
  /** The interviewer's lines on this topic (Oct 22 2026): what the video is meant to answer. */
  asked: AskedLine[];
  brief: TopicBrief;
  hooks: HookCandidate[];
  chosen: number;
  /** v2.3: why the chosen hook is a fallback (no hook reached curiosity 4 and tension 4), or null. */
  hookFallback: string | null;
  /** v2.3: the hooks this month's other scripts open with, shown to the hooks step for variety. */
  siblingHooks: string[];
  runs: { retrieval: string | null; brief: string | null; hooks: string | null; olderRetrieval?: string | null };
};

/**
 * Is the brief's proof a story she told (v2.3)? The brief says so
 * (proof.isHerStory), or the proof cites a passage the retrieval read as a
 * story or a client example. On a hook tie, her own moment then wins. Pure.
 */
export function proofIsHerStory(brief: Pick<TopicBrief, "proof">, passages: readonly Pick<WriterPassage, "id" | "kind">[]): boolean {
  if (!brief.proof?.text) return false;
  if (brief.proof.isHerStory === true) return true;
  const ids = new Set((brief.proof.source ?? "").match(/\bP\d+\b/g) ?? []);
  return passages.some((p) => ids.has(p.id) && (p.kind === "story" || p.kind === "client_example"));
}

/**
 * The hooks the month's other scripts open with (v2.3, for variety: one
 * month's scripts for one client should not all open the same way). Their
 * current versions; as of a moment in the past for the offline test. Never
 * fails the draft: no siblings on any error.
 */
export async function siblingHooksFor(o: { topicId: string; monthId: string | null; enrollmentId: string; asOf?: Date | null }): Promise<string[]> {
  if (!o.monthId) return [];
  try {
    // The OR keeps scripts with no topic: a NOT on a nullable column alone would drop them.
    const scripts = await prisma.contentScript.findMany({ where: { enrollmentId: o.enrollmentId, monthId: o.monthId, historical: false, OR: [{ topicId: null }, { topicId: { not: o.topicId } }], ...(o.asOf ? { createdAt: { lte: o.asOf } } : {}) }, select: { id: true, currentVersionId: true }, orderBy: { createdAt: "asc" }, take: 12 });
    if (!scripts.length) return [];
    const versions = o.asOf
      ? await prisma.contentScriptVersion.findMany({ where: { scriptId: { in: scripts.map((s) => s.id) }, createdAt: { lte: o.asOf } }, orderBy: { versionNo: "desc" }, select: { scriptId: true, hook: true } })
      : await prisma.contentScriptVersion.findMany({ where: { id: { in: scripts.map((s) => s.currentVersionId).filter((x): x is string => !!x) } }, select: { scriptId: true, hook: true } });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of scripts) {
      const v = versions.find((x) => x.scriptId === s.id);
      const h = (v?.hook ?? "").replace(/\s+/g, " ").trim();
      if (!v || seen.has(s.id) || !h) continue;
      seen.add(s.id);
      if (!out.includes(h)) out.push(h.slice(0, 200));
    }
    return out.slice(0, 8);
  } catch { return []; }
}

/**
 * Gather, then read. Oct 22 2026 (the listening fix): the retrieval runs in two
 * steps. First the topic's call(s) and the recorded excerpts; then her words
 * there (with the interviewer's question around them) choose the windows of
 * her OLDER calls, the facts the brief reads and her same-subject scripts
 * (sources.withHerWords), and a second retrieval reads those windows for what
 * they add. Both readings' passages go to the brief and the review alike.
 */
export async function prepareDraft(o: GatherOpts & { requestedBy: string; unattended: boolean; deadline?: number | null; offline?: boolean }): Promise<Prepared> {
  const g0 = await gatherForTopic(o);
  const rcOf = (g: Gathered): RunCtx => ({ requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: { topicId: o.topicId, monthId: o.monthId, ...(o.offline ? { offline: true, asOf: o.asOf?.toISOString() ?? null } : {}) }, enrollmentId: g.enrollmentId, clientId: g.clientId, strategyVersionId: g.strategyVersionId, policyVersionId: g.policyVersionId, inputRefs: g.inputRefs });
  const key = (step: string) => `writer:${o.offline ? "offline:" : ""}${step}:${o.topicId}:${o.monthId ?? "bank"}`;
  let out: RetrievalOut = { passages: [] };
  let overview: string | null = null;
  let retrievalRun: string | null = null;
  if (g0.sources.length) {
    const r = await runWriterStep<RetrievalOut>("retrieval", buildRetrievalPrompt(g0.ctx, g0.sources), rcOf(g0), { dedupeKey: key("retrieval") });
    out = { passages: Array.isArray(r.output?.passages) ? r.output.passages : [] };
    overview = s400(r.output?.overview) || null;
    retrievalRun = r.runId;
  }
  const first = await passagesFrom(g0, out);
  const g = withHerWords(g0, first.kept);
  const rc = rcOf(g);
  let olderRun: string | null = null;
  const olderSources = g.sources.filter((s) => s.kind === "older");
  if (olderSources.length) {
    const r2 = await runWriterStep<RetrievalOut>("retrieval", buildRetrievalPrompt(g.ctx, olderSources, { already: first.kept.map((p) => ({ quote: p.quote, source: p.source })) }), rc, { dedupeKey: key("retrieval-older") });
    // Only what it was shown: a quote it gives from the topic's call was already read the first time.
    const olderIds = new Set(olderSources.map((s) => s.id));
    out = { passages: [...out.passages, ...(Array.isArray(r2.output?.passages) ? r2.output.passages : []).filter((p) => olderIds.has(String(p?.sourceId ?? "").trim()))] };
    olderRun = r2.runId;
  }
  const got = olderSources.length ? await passagesFrom(g, out) : first;
  const passages = got.kept;
  const excluded = got.excluded;
  // v2.1: the brief checks against the whole call, not only the passages.
  const b = await runWriterStep<BriefOut>("brief", buildBriefPrompt(g.ctx, passages, excluded, overview, g.callText, got.asked), rc, { dedupeKey: key("brief") });
  // v2.4: her approved and filmed scripts (all of them, not only the same-subject ones): a story she already told on camera is never the proof.
  const brief = briefFrom(b.output, passages, got.asked, { onCamera: (g.scriptCands ?? []).map((c) => ({ title: c.title, text: c.body })) });
  // v2.3: the month's other openings ride into the hooks step (variety), and her own moment wins a tie when the proof is her story.
  const siblingHooks = await siblingHooksFor({ topicId: o.topicId, monthId: o.monthId, enrollmentId: g.enrollmentId, asOf: o.asOf ?? null });
  const h = await runWriterStep<{ hooks?: Parameters<typeof pickHook>[0] }>("hooks", buildHooksPrompt(g.ctx, brief, { siblings: siblingHooks }), rc, { dedupeKey: key("hooks") });
  // v2.5: a hook whose hook and re-hook tell the excluded proof (a live deal, a story already filmed) is set aside.
  const picked = pickHook(h.output?.hooks ?? [], { videoType: brief.videoType, proofIsStory: proofIsHerStory(brief, passages), avoid: (brief.heldBack ?? []).map((x) => x.text), kept: keptTextOf(brief) });
  return { g, passages, excluded, overview, asked: got.asked, brief, hooks: picked.hooks, chosen: picked.chosen, hookFallback: picked.fallback, siblingHooks, runs: { retrieval: retrievalRun, brief: b.runId, hooks: h.runId, olderRetrieval: olderRun } };
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
    v: 2, version: WRITER_VERSION, brief: p.brief, passages: p.passages, excludedPassages: p.excluded, hooks: p.hooks, chosen: p.chosen, hookFallback: p.hookFallback ?? null, rationale: rationaleOf(draft.output),
    facts: p.g.ctx.facts, sources: p.g.labels, runs: { retrieval: p.runs.retrieval, brief: p.runs.brief, hooks: p.runs.hooks, draft: draft.runId, ...(p.runs.olderRetrieval ? { olderRetrieval: p.runs.olderRetrieval } : {}) }, asOf: asOf?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Review (the 12 checks, the craft block + the hard numbers)
// ---------------------------------------------------------------------------

type ReviewOut = { checks?: { key?: string; pass?: boolean; reason?: string }[]; craft?: unknown; fixInstruction?: string; summary?: string };
/** `craft` (v2.3): the five parts scored 1 to 5 with a psychology note each (check 13 reads it). `story` (v2.4): the brief marks a told personal story (it may use up to the cap). */
export type ReviewResult = { checks: ReviewCheckResult[]; hard: HardFinding[]; mustFails: ReviewCheckResult[]; craft: CraftScores | null; fixInstruction: string | null; summary: string | null; words: number; seconds: number; runId: string; story?: boolean };

/** What she said or approved, as the hard numbers read it (never our assumptions); v2.1: the whole call too. */
export function clientTextOf(rec: Pick<WriterRecord, "passages" | "facts">, ctx: Pick<WriterContext, "answers" | "strategyText" | "relatedScripts">, callText = ""): string {
  return [...rec.passages.flatMap((p) => [p.quote, p.context]), ...rec.facts.map((f) => f.body), ...ctx.answers.map((a) => a.answer), ...ctx.relatedScripts.map((r) => r.text), ctx.strategyText ?? "", callText].join("\n");
}

/** What she SAID out loud (the passages and the whole call): the text a pasted sentence is looked for in. */
export function spokenSourceOf(rec: Pick<WriterRecord, "passages">, callText = ""): string {
  return [...rec.passages.flatMap((p) => [p.quote, p.context]), callText].join("\n");
}

export async function reviewParts(ctx: WriterContext, rec: WriterRecord, parts: ScriptParts & { closeType?: string | null }, rc: RunCtx, opts: { dedupeKey?: string | null; callText?: string | null } = {}): Promise<ReviewResult> {
  const callText = opts.callText ?? "";
  const story = rec.brief.videoType === "story";
  // v2.5: code fails a script that tells the live deal the brief keeps out (live_deal), and a build-up that
  // translates the hook's words in the format agreed on the call is not an echo.
  const numbers = hardNumbers(parts, clientTextOf(rec, ctx, callText), spokenSourceOf(rec, callText), { story, liveDeal: liveDealOf(rec.brief), kept: keptTextOf(rec.brief), agreedFormat: agreedFormatOf(rec.brief) });
  const body = [`HOOK: ${parts.hook}`, ...parts.points.map((p, i) => `${["RE-HOOK", "BUILD-UP", "PAYOFF"][i] ?? "POINT"}: ${p.text}`), `CLOSE: ${parts.close}`].join("\n");
  const prompt = buildReviewPrompt({ ...ctx, facts: rec.facts }, rec.brief, rec.passages, { body, closeType: parts.closeType ?? null }, { words: numbers.words, seconds: numbers.seconds, hookWords: numbers.hookWords, hard: numbers.findings.map((f) => f.detail) }, callText);
  // Every version gets its own review run (never a reused verdict): the ledger shows each check.
  const r = await runWriterStep<ReviewOut>("review", prompt, rc, { dedupeKey: opts.dedupeKey ?? null, reuse: false });
  const craft = readCraft(r.output?.craft);
  // v2.4: the craft score of a hook still word for word a scored pick that met HOOK_BAR is advice.
  const checks = mergeReview(Array.isArray(r.output?.checks) ? r.output.checks : [], numbers.findings, numbers.words, craft, { hookAdvisory: hookIsBarPick(rec.hooks, parts.hook), story });
  const mustFails = mustFixFailures(checks);
  const fix = typeof r.output?.fixInstruction === "string" ? r.output.fixInstruction.trim().slice(0, 3000) : "";
  return { checks, hard: numbers.findings, mustFails, craft, fixInstruction: checks.some((c) => !c.pass) ? fix || null : null, summary: s400(r.output?.summary) || null, words: numbers.words, seconds: numbers.seconds, runId: r.runId, story };
}

/**
 * After a review, what happens next (the automatic check, a person's "Fix
 * with AI" and the offline run share this order):
 *   the version IS the aim trim, and it  → revert: the longer version it came
 *     broke a must-fix check other than     from is kept (never dry or
 *     length ("Enough substance" when it    incomplete); "Longer than the 55
 *     dropped a must-keep point)            to 85 aim" stays as advice. v2.3:
 *                                           when the longer version says the
 *                                           line the trim failed on, it is
 *                                           kept FLAGGED (keptLongerConflicts)
 *   nothing must-fix fails, over 85 words,→ the aim trim: ONE pass toward 65
 *     no aim trim yet (trimAbove; v2.5:       to 75, must-keep points kept
 *     85, it was 78)
 *   nothing must-fix fails                → pass (flags stay on the card)
 *   only the length fails, no cap trim yet→ the cap trim (110 or fewer)
 *   fix rounds left (two at most)         → a fix round (it trims too when over)
 *   v2.5: the two rounds used, and Enough → ONE third fix round (the Seniors
 *     substance is the only must-fix left    draft only needed "retirement
 *     (so the craft check passed)            community" named)
 *   still over the cap, no cap trim yet   → the cap trim
 *   otherwise                             → flagged for Jordan, never quietly passed
 *
 * v2.4 (the length fix): BEFORE the first review (`reviewed: false`), a draft
 * over trimAbove gets the aim trim first and the trimmed version is reviewed
 * ("aim-trim"), else the draft is reviewed ("review"). Sonnet drafted at 87
 * words on average and the trim only ran after a passing review, so on none.
 * A told personal story (`story`) is never aim-trimmed: it may use up to the cap.
 */
export type WriterStep = "pass" | "trim" | "aim-trim" | "revert" | "fix" | "flag" | "review";
export function nextWriterStep(o: { mustFails: ReviewCheckResult[]; words: number; fixRounds: number; trimmed: boolean; aimTrimmed?: boolean; isAimTrim?: boolean; maxFixRounds?: number; reviewed?: boolean; story?: boolean | null }): WriterStep {
  const trimAbove = trimAboveFor(o.story);
  if (o.reviewed === false) return !o.story && o.words > trimAbove && !o.aimTrimmed && !o.trimmed && !o.isAimTrim && !o.fixRounds ? "aim-trim" : "review";
  if (o.isAimTrim && o.mustFails.some((c) => c.key !== "length")) return "revert";
  if (!o.mustFails.length) return !o.story && o.words > trimAbove && !o.aimTrimmed && !o.isAimTrim ? "aim-trim" : "pass";
  if (o.mustFails.every((c) => c.key === "length") && !o.trimmed) return "trim";
  if (o.fixRounds < (o.maxFixRounds ?? 2)) return "fix";
  if (thirdRoundFor(o)) return "fix";
  if (o.words > WRITER_LENGTH.cap && !o.trimmed) return "trim";
  return "flag";
}

/**
 * v2.5: the one extra fix round. After the usual rounds, when Enough
 * substance is the ONLY must-fix left (the craft check fails at must-fix, so
 * it passed), one more round runs: a missing must-keep point is a small,
 * named fix (Marcee's Seniors draft only needed "retirement community"
 * named). Never a fourth. Pure.
 */
export function thirdRoundFor(o: { mustFails: readonly Pick<ReviewCheckResult, "key">[]; fixRounds: number; maxFixRounds?: number }): boolean {
  return o.fixRounds === (o.maxFixRounds ?? 2) && o.mustFails.length > 0 && o.mustFails.every((c) => c.key === "substance");
}

/** The brief's must-keep points as the trim instruction names them. */
export function mustKeepTexts(brief: Pick<TopicBrief, "mustKeep"> | null | undefined): string[] {
  return (brief?.mustKeep ?? []).map((m) => m.text).filter(Boolean);
}

/**
 * The note a kept-longer version carries on the card (and in the offline
 * result). v2.3: the aim advice only when it is over the aim; and when the
 * trim's review failed a line this version says too, the note names it (the
 * version is flagged, not passed).
 */
export function keptLongerNote(versionLabel: string, words: number, conflicts: readonly { n: number; label: string; line: string }[] = [], trimFailed: readonly Pick<ReviewCheckResult, "key" | "n" | "label">[] = []): string {
  return [
    `Kept ${versionLabel} (${words} words, about ${estimateSeconds(words)} seconds): the trim toward ${WRITER_LENGTH.trimTo[0]} to ${WRITER_LENGTH.trimTo[1]} words ${trimFailWhy(trimFailed)}, so the longer ${conflicts.length ? "" : "passing "}version stands.`,
    words > WRITER_LENGTH.aim[1] ? `"Longer than the ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} aim" stays as advice.` : "",
    conflicts.length ? `Flagged: the trim's review failed a line this version says too (${conflicts.slice(0, 3).map((c) => `${c.n}. ${c.label}: "${c.line}"`).join("; ")}). Read it before approving.` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Why an aim trim was undone, in words (v2.3): "dropped a must-keep point"
 * when it failed Enough substance (or nothing more is known), else the
 * must-fix checks it failed (the close is must-fix now, so a trim can be
 * undone for its close). Pure.
 */
export function trimFailWhy(fails: readonly Pick<ReviewCheckResult, "key" | "n" | "label">[]): string {
  const other = fails.filter((c) => c.key !== "length");
  if (!other.length || other.some((c) => c.key === "substance")) return "dropped a must-keep point";
  return `failed a must-fix check (${other.slice(0, 3).map((c) => `${c.n}. ${c.label}`).join(", ")})`;
}

/** A kept longer version's checks with the trim's failures on its own lines carried in (v2.3), so the card names them. Pure. */
export function carryConflicts(keptChecks: readonly ReviewCheckResult[], trimChecks: readonly ReviewCheckResult[], conflicts: readonly { key: ReviewCheckResult["key"]; line: string }[]): ReviewCheckResult[] {
  return keptChecks.map((c) => {
    const hit = conflicts.filter((x) => x.key === c.key);
    if (!hit.length) return c;
    const t = trimChecks.find((x) => x.key === c.key);
    return { ...c, pass: false, level: "must-fix", reason: `The trim's review failed this line, and this version says it too ("${hit[0].line}"). ${t?.reason ?? ""}`.trim().slice(0, 500), ...(t?.parts ? { parts: t.parts } : {}) };
  });
}

/**
 * What a fix round is told: every failing check (must-fix first), the
 * reviewer's instruction, the trim, and no invention. v2.4: the trim rides
 * along whenever the version is over trimAbove (it was only over the cap, and
 * fix rounds added words); a told story only over the cap.
 */
export function writerFixInstruction(j: { checks?: ReviewCheckResult[]; hard?: HardFinding[]; fixInstruction?: string | null; words?: number }, mustKeep: readonly string[] = [], opts: { story?: boolean | null } = {}): string {
  const checks = j.checks ?? [];
  const must = checks.filter((c) => !c.pass && c.level === "must-fix");
  const flags = checks.filter((c) => !c.pass && c.level === "flag");
  return [
    "The independent creative review found problems with this version. Fix these and keep every line that passed word for word where you can.",
    must.length ? `MUST FIX:\n${must.map((c) => `- ${c.n}. ${c.label}: ${c.reason}`).join("\n")}` : "",
    flags.length ? `ALSO IMPROVE IF YOU CAN WITHOUT LOSING ANYTHING:\n${flags.map((c) => `- ${c.n}. ${c.label}: ${c.reason}`).join("\n")}` : "",
    j.fixInstruction ? `THE REVIEWER'S INSTRUCTION: ${j.fixInstruction}` : "",
    (j.words ?? 0) > trimAboveFor(opts.story) ? trimInstruction(j.words ?? 0, mustKeep, { story: opts.story }) : "",
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

/** The context for a review or a revision of a script the writer drafted: the record carries the passages; the topic's call is read again in full (v2.1) so a claim is checked against all of it. */
export async function contextForScript(s: { topicId: string | null; monthId: string | null; id: string }, rec: WriterRecord): Promise<{ ctx: WriterContext; callText: string }> {
  if (!s.topicId) throw new Error("This script has no topic, so the new writer cannot rebuild its context.");
  const g = await gatherForTopic({ topicId: s.topicId, monthId: s.monthId, excludeScriptId: s.id, light: true, asOf: rec.asOf ? new Date(rec.asOf) : null });
  // The facts the brief was built on, not whatever the file holds today.
  return { ctx: { ...g.ctx, facts: rec.facts }, callText: g.callText };
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
  const { ctx, callText } = await contextForScript(s, rec);
  let closeType: string | null = null;
  try { closeType = (JSON.parse(v.validationJson ?? "{}") as { closeType?: string }).closeType ?? null; } catch { closeType = null; }
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: { scriptId: s.id, versionId }, enrollmentId: s.enrollmentId, clientId: s.clientId, strategyVersionId: v.strategyVersionId, policyVersionId: v.policyVersionId, inputRefs: { versionId, briefRunId: rec.runs.brief } };
  const r = await reviewParts(ctx, rec, { ...partsOfVersion(v), closeType: closeType ?? rec.brief.closeType }, rc, { dedupeKey: `review:${versionId}`, callText });
  return { ...r, closeType };
}

/** What the review said, as a fix round reads it (v2.4): the checks, the code's findings and the craft block, or only the instruction. */
export type ReviewSaid = { checks?: ReviewCheckResult[] | null; hard?: HardFinding[] | null; craft?: CraftScores | null; instruction?: string | null };

/**
 * The hook a fix round starts again from (Oct 22 2026, the listening fix),
 * or null. v2.4 (keep the good hook): only when the HOOK failed, and only
 * when it failed on accuracy, meaning or a hard finding (rules.hookVerdict),
 * or the craft block scored it CRAFT_FAIL_AT or under and the runner-up ranks
 * at least as high (rules.hookRank). Then the next-best usable hook that
 * neither the first draft nor the current version used. A failed re-hook, or
 * a hook the reviewer only liked less, keeps the hook (reviewRoundPlan locks
 * it). Across the v2.3 retest, 9 of 20 swap rounds raised the must-fix count. Pure.
 */
export function switchHookFor(rec: Pick<WriterRecord, "hooks" | "chosen" | "brief"> & Partial<Pick<WriterRecord, "passages">>, current: { body: string; hook?: string | null }, failed: ReviewSaid): HookCandidate | null {
  if (!rec.hooks.length) return null;
  const curText = current.hook ?? hookInUse(current.body, rec.hooks) ?? "";
  const v = hookVerdict(failed, curText);
  if (!v.hard && !(v.failed && v.craftHook != null && v.craftHook <= CRAFT_FAIL_AT)) return null;
  const used = [rec.chosen >= 0 ? rec.hooks[rec.chosen]?.text ?? "" : "", hookInUse(current.body, rec.hooks) ?? "", curText].filter(Boolean);
  // v2.3: the same order the hook was picked in (eligible first, then the rank, her moment on a tie when the proof is her story).
  const next = runnerUpHook(rec.hooks, used, { videoType: rec.brief.videoType ?? null, proofIsStory: proofIsHerStory(rec.brief, rec.passages ?? []) });
  if (!next || v.hard) return next;
  // The craft path: only to a runner-up that ranks at least as high as the hook in use (a hook the writer made up ranks 0).
  const cur = rec.hooks.find((h) => h.text && curText && h.text.replace(/\s+/g, " ").trim().toLowerCase() === curText.replace(/\s+/g, " ").trim().toLowerCase());
  return hookRank(next) >= (cur ? hookRank(cur) : 0) ? next : null;
}

/**
 * The parts a review passed (v2.4): no failing must-fix check names it, and
 * the craft block scored it CRAFT_PASS or more when it scored it. When a
 * must-fix failure names no part (Enough substance, Her meaning, the length),
 * nothing counts as passed: any part may have to change to fix it. Pure.
 */
export function partsPassed(review: ReviewSaid): ScriptPartKey[] {
  const failing = (review.checks ?? []).filter((c) => !c.pass && c.level === "must-fix");
  if (!review.checks?.length) return [];
  if (failing.some((c) => !(c.parts ?? CHECK_PARTS[c.key] ?? []).length)) return [];
  return SCRIPT_PART_KEYS.filter((k) => {
    if (failing.some((c) => (c.parts ?? CHECK_PARTS[c.key] ?? []).includes(k))) return false;
    const s = review.craft?.[k]?.score;
    return !review.craft || (typeof s === "number" && s >= CRAFT_PASS);
  });
}

/**
 * What a review fix round does (v2.4, pure): `switchTo` the runner-up hook
 * (a redraft from its hook only, never its re-hook, every part that passed
 * kept word for word), or revise with the hook LOCKED. The hook is left
 * unlocked only when it failed on accuracy, meaning or a hard finding and no
 * runner-up is left (it must change). `lock` is what code copies back.
 */
export function reviewRoundPlan(rec: Pick<WriterRecord, "hooks" | "chosen" | "brief"> & Partial<Pick<WriterRecord, "passages">>, current: { body: string; hook?: string | null }, review: ReviewSaid): { switchTo: HookCandidate | null; lock: ScriptPartKey[] } {
  const switchTo = switchHookFor(rec, current, review);
  if (switchTo) return { switchTo, lock: partsPassed(review).filter((k) => k !== "hook") };
  const v = hookVerdict(review, current.hook ?? hookInUse(current.body, rec.hooks) ?? "");
  return { switchTo: null, lock: v.hard ? [] : ["hook"] };
}

/** A part's label as the prompts name it (Hook, Re-hook, Build-up, Payoff, Close). */
export const partLabel = (k: ScriptPartKey) => CRAFT_PARTS.find((p) => p.key === k)?.label ?? k;

/** The new parts with the locked ones copied back from the old, word for word (pure). */
export function withLocked(next: ScriptParts, prev: ScriptParts, lock: readonly ScriptPartKey[]): ScriptParts {
  const out: ScriptParts = { hook: next.hook, points: next.points.map((p) => ({ ...p })), close: next.close };
  for (const k of lock) {
    if (k === "hook") out.hook = prev.hook;
    else if (k === "close") out.close = prev.close;
    else {
      const i = k === "rehook" ? 0 : k === "buildup" ? 1 : 2;
      const t = partTextOf(prev, k);
      if (out.points[i]) out.points[i] = { ...out.points[i], text: t };
      else out.points[i] = { role: ["re-hook", "build-up", "payoff"][i], text: t };
    }
  }
  return out;
}

/**
 * The revise prompt for a script the writer drafted (fix rounds, the trim pass, a person's or a client's request).
 * A review fix round follows reviewRoundPlan (v2.4): a redraft from the runner-up hook only when the hook itself
 * failed on accuracy, meaning or a hard finding (or scored 2 or under against a runner-up as strong), else a
 * revision with the hook locked. `review` is the version's judge record (its checks, findings and craft); without
 * it the plan reads the instruction. `lock` names the parts code copies back. A person's request or a trim never switches.
 */
export async function writerRevisePrompt(s: { id: string; topicId: string | null; monthId: string | null }, rec: WriterRecord, current: { versionNo: number; body: string; hook?: string | null }, instruction: string, opts: { lockedLabels?: string[]; who: "review" | "trim" | "person" | "client"; review?: ReviewSaid | null }): Promise<StepPrompt & { lock: ScriptPartKey[] }> {
  const { ctx } = await contextForScript(s, rec);
  const personLocked = (opts.lockedLabels ?? []).some((l) => /hook/i.test(l));
  if (opts.who === "review" && !personLocked) {
    const plan = reviewRoundPlan(rec, current, { ...(opts.review ?? {}), instruction });
    if (plan.switchTo) return { ...buildRedraftPrompt(ctx, rec.brief, rec.passages, { text: plan.switchTo.text }, current, instruction, { keep: plan.lock.map(partLabel) }), lock: plan.lock };
    return { ...buildReviseWriterPrompt(ctx, rec.brief, rec.passages, current, instruction, { ...opts, lockedLabels: [...new Set([...(opts.lockedLabels ?? []), ...plan.lock.map(partLabel)])] }), lock: plan.lock };
  }
  return { ...buildReviseWriterPrompt(ctx, rec.brief, rec.passages, current, instruction, opts), lock: [] };
}

// ---------------------------------------------------------------------------
// PHASE 3's OFFLINE RUN: the whole pipeline on one topic, as of a moment in
// the past, with nothing written but the AI run rows (scope offline: true).
// No script, no version, no portal, no message. For the go / no-go test.
// ---------------------------------------------------------------------------

export type OfflineAttempt = { label: string; parts: ScriptParts; closeType: string | null; words: number; seconds: number; review: ReviewResult | null; note?: string | null };

export async function draftOffline(o: { topicId: string; monthId: string | null; asOf?: Date | null; requestedBy: string; callRecordId?: string | null }): Promise<{ prepared: Omit<Prepared, "g">; record: WriterRecord; attempts: OfflineAttempt[]; final: OfflineAttempt; state: "passed" | "flagged"; keptLonger: boolean }> {
  const p = await prepareDraft({ topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null, asOf: o.asOf ?? null, requestedBy: o.requestedBy, unattended: false, offline: true });
  const scope = { topicId: o.topicId, monthId: o.monthId, offline: true, asOf: o.asOf?.toISOString() ?? null };
  const draft = await runWriterStep<DraftOut>("draft", buildDraftPrompt(p.g.ctx, p.brief, p.passages, p.chosen >= 0 ? { text: p.hooks[p.chosen].text, rehook: p.hooks[p.chosen].rehook } : null), { requestedBy: o.requestedBy, unattended: false, scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, inputRefs: p.g.inputRefs });
  const rec = writerRecordOf(p, draft, o.asOf ?? null);
  const toParts = (out: DraftOut, hook: string | null) => { const j = generatedFromDraft(out, hook, p.g.ctx.topic.pillar); return { parts: { hook: j.hook, points: j.points.map((x) => ({ role: String(x.role), text: x.text })), close: j.close } as ScriptParts, closeType: out?.closeType ?? null }; };
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: false, scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId };
  const attempts: OfflineAttempt[] = [];
  const mustKeep = mustKeepTexts(p.brief);
  const story = p.brief.videoType === "story";
  let cur = toParts(draft.output, p.chosen >= 0 ? p.hooks[p.chosen].text : null);
  let fixRounds = 0, trimmed = false, aimTrimmed = false, label = "draft";
  // v2.4 (the length fix): a draft over trimAbove is trimmed BEFORE its first review; the draft stays in the trail, unreviewed.
  const draftWords = countSpokenWords(spokenTextOf(cur.parts));
  if (nextWriterStep({ reviewed: false, mustFails: [], words: draftWords, fixRounds: 0, trimmed: false, story }) === "aim-trim") {
    attempts.push({ label, parts: cur.parts, closeType: cur.closeType, words: draftWords, seconds: estimateSeconds(draftWords), review: null, note: `Trimmed toward ${WRITER_LENGTH.trimTo[0]} to ${WRITER_LENGTH.trimTo[1]} words before its first review.` });
    const trimmedOut = await runWriterStep<DraftOut>("revise", buildReviseWriterPrompt(p.g.ctx, p.brief, p.passages, { versionNo: attempts.length, body: spokenTextOf(cur.parts) }, trimInstruction(draftWords, mustKeep), { who: "trim" }), rc);
    cur = toParts(trimmedOut.output, null);
    aimTrimmed = true; trimmed = draftWords > WRITER_LENGTH.cap; label = "trim to aim";
  }
  // The passing attempt the aim trim started from, while the next review is of that trim.
  let aimFrom: OfflineAttempt | null = null;
  // v2.5: one more pass for the third fix round (thirdRoundFor).
  for (let guard = 0; guard < 8; guard++) {
    const review = await reviewParts(p.g.ctx, rec, { ...cur.parts, closeType: cur.closeType }, rc, { callText: p.g.callText });
    const attempt: OfflineAttempt = { label, parts: cur.parts, closeType: cur.closeType, words: review.words, seconds: review.seconds, review };
    attempts.push(attempt);
    // The same order as the automatic check on the version trail (scriptJudge.ts).
    const next = nextWriterStep({ mustFails: review.mustFails, words: review.words, fixRounds, trimmed, aimTrimmed, isAimTrim: !!aimFrom, story });
    if (next === "revert" && aimFrom) {
      // v2.3: the kept version may not say the line the trim's review failed on; when it does, it is flagged.
      const conflicts = keptLongerConflicts({ parts: attempt.parts, checks: review.checks }, aimFrom.parts);
      const keptReview = conflicts.length && aimFrom.review ? { ...aimFrom.review, checks: carryConflicts(aimFrom.review.checks, review.checks, conflicts), mustFails: mustFixFailures(carryConflicts(aimFrom.review.checks, review.checks, conflicts)) } : aimFrom.review;
      return { prepared: strip(p), record: rec, attempts, final: { ...aimFrom, review: keptReview, note: keptLongerNote(aimFrom.label, aimFrom.words, conflicts, review.mustFails) }, state: conflicts.length ? "flagged" : "passed", keptLonger: true };
    }
    if (next === "pass") return { prepared: strip(p), record: rec, attempts, final: attempt, state: "passed", keptLonger: false };
    if (next === "flag" || next === "revert" || next === "review") break;
    let instruction: string, who: "review" | "trim";
    aimFrom = null;
    if (next === "aim-trim") { instruction = trimInstruction(review.words, mustKeep, { story }); who = "trim"; aimTrimmed = true; aimFrom = attempt; label = "trim to aim"; }
    else if (next === "trim") { instruction = trimInstruction(review.words, mustKeep, { story }); who = "trim"; trimmed = true; label = "trim"; }
    else { instruction = writerFixInstruction({ checks: review.checks, hard: review.hard, fixInstruction: review.fixInstruction, words: review.words }, mustKeep, { story }); who = "review"; fixRounds++; label = `fix ${fixRounds}`; }
    const body = spokenTextOf(cur.parts);
    // v2.4 (keep the good hook): a redraft from the runner-up hook only when the hook itself failed on accuracy,
    // meaning or a hard finding (or scored 2 or under against a runner-up as strong); else the hook is locked.
    const plan = who === "review" ? reviewRoundPlan(rec, { body, hook: cur.parts.hook }, { checks: review.checks, hard: review.hard, craft: review.craft }) : { switchTo: null, lock: [] as ScriptPartKey[] };
    const step = plan.switchTo
      ? buildRedraftPrompt(p.g.ctx, p.brief, p.passages, { text: plan.switchTo.text }, { versionNo: attempts.length, body }, instruction, { keep: plan.lock.map(partLabel) })
      : buildReviseWriterPrompt(p.g.ctx, p.brief, p.passages, { versionNo: attempts.length, body }, instruction, { who, lockedLabels: plan.lock.map(partLabel) });
    if (plan.switchTo) label = `${label} (runner-up hook)`;
    const revised = await runWriterStep<DraftOut>("revise", step, rc);
    const next2 = toParts(revised.output, plan.switchTo?.text ?? null);
    cur = { ...next2, parts: withLocked(next2.parts, cur.parts, plan.lock) };
  }
  // v2.4: never over the cap when a version at or under it exists; then craft (the hook twice); then fewest must-fixes; then words over 85.
  // v2.5: an educational version inside the aim before any over it, ahead of craft.
  const reviewed = attempts.filter((a) => a.review);
  const best = reviewed[pickFinal(reviewed.map((a) => ({ words: a.words, craft: a.review?.craft ?? null, mustFix: a.review?.mustFails.length ?? 99, story })))] ?? attempts[attempts.length - 1];
  return { prepared: strip(p), record: rec, attempts, final: best, state: "flagged", keptLonger: false };
}
const strip = (p: Prepared): Omit<Prepared, "g"> => { const { g: _g, ...rest } = p; void _g; return rest; };
