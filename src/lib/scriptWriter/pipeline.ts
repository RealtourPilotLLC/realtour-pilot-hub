import "server-only";
import { prisma } from "@/lib/prisma";
import { runAiJson, sha256, type AiRunKind, type ClaimedRun } from "@/lib/aiRuns";
import { timeoutBefore, type AiEffort } from "@/lib/integrations/ai";
import type { GeneratedScriptJson, Gap } from "@/lib/contentPolicy";
import { gatherForTopic, withHerWords, type Gathered, type GatherOpts } from "./sources";
import { buildRetrievalPrompt, buildBriefPrompt, buildDraftPrompt, buildReviewPrompt, buildRewritePrompt, buildReviseWriterPrompt, partsBlock, type DraftOut, type ReviewOut, type StepPrompt, type WriterContext } from "./prompts";
import { locateQuote, contextAround, timeOf, isInternalTalk } from "./passages";
import { hardNumbers, mergeViewerReview, mustFixFailures, partTextOf, agreedFormatOf, usedStory, isBetterAttempt, WRITER_LENGTH, WRITER_VERSION, BRIEF_MUST_KEEP_MAX, MAX_REWRITES, VIEWER_CHECK_KEYS, estimateSeconds, type CraftScores, type ReviewCheckResult, type HardFinding, type ScriptParts } from "./rules";
import { readWriter, type TopicBrief, type WriterPassage, type WriterRecord, type WriterRationale } from "./record";

// ---------------------------------------------------------------------------
// THE SCRIPT WRITER (Oct 22 2026; v2.6 on Oct 23 2026: ONE THOUGHT).
//
//   gather      sources.ts: the topic's call in full, older call windows, her
//               facts (unreviewed client-spoken ones too), same-subject scripts,
//               voice examples, why the topic was chosen                (no AI)
//   retrieval   every passage where she talks about the topic, verbatim, found
//               in the source by code with the lines around it; internal talk
//               held back                          (claude-haiku-5-5, medium)
//   brief       the topic brief: one angle, one proof, her phrases, what is
//               kept and what is left out         (claude-sonnet-5-5, medium)
//   draft       v2.6: ONE call writes the whole script, all five parts
//               together, from the brief and her own words, with three
//               examples of the bar                (claude-sonnet-5-5, high)
//   review      v2.6: reads it as a viewer FIRST (one thought, she would say
//               it, the hook lands and the rest follows, nothing invented)
//               and gives a 1 to 10 read; then code's hard checks (the 110
//               cap, no dashes, no durations, her numbers, her quotes, no
//               live deal)                         (claude-sonnet-5-5, medium)
//   rewrite     v2.6: when the review or a hard check fails, ONE whole
//               rewrite with the reviewer's note, reviewed in turn; it becomes
//               the current version only when it reads better. Never a
//               second one, never a patch of one part
//                                (claude-sonnet-5-5, high; kind script_revise)
// (scriptJudge.ts runs the review and the rewrite on the version trail.)
//
// MODEL CALLS PER SCRIPT. v2.6: retrieval 1 (2 with older calls), brief 1,
// draft 1, review 1: four or five for a draft that passes, six or seven when
// it is rewritten (the rewrite and its review). v2.5 had a hooks step, a trim
// before the first review, up to three fix rounds that each patched one part
// and a cap trim and an aim trim, each reviewed again: five at the least,
// about ten on Erica Walker's October drafts, fifteen and more at the most.
//
// Every step is a ProgramAiRun (kind script_retrieval / script_brief /
// script_draft / script_review / script_revise). A retrieval or a brief whose
// exact prompt already ran in the last two days reuses that run's answer, so
// a sweep that runs out of time (WriterPausedError) picks up where it stopped
// on the next tick instead of paying again.
//
// THE SWITCH. AppSetting "script_writer_v2" ({ "on": true } or { "on": true,
// "enrollmentIds": [...] } for a pilot; since Oct 22 2026, Erica Walker and
// Bernadette Rabel). Missing or off = the writer the hub has used since Oct 14
// drafts every script, exactly as before. A skit never comes here: it stays
// on that writer (contentGeneration.routeScriptDraft).
//
// Never touched: a version that is approved or shared, any script a client
// has been sent, and a version a person wrote or asked for (only a version
// that carries an owed review is reviewed or rewritten). Every draft still
// lands in Jordan's review queue; script_auto_share stays TEST-locked.
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

type Step = "retrieval" | "brief" | "draft" | "review" | "revise";
const STEP_KIND: Record<Step, AiRunKind> = { retrieval: "script_retrieval", brief: "script_brief", draft: "script_draft", review: "script_review", revise: "script_revise" };
/**
 * THE MODEL MAP (Oct 22 2026, writer v2.3; Jordan: "$18 for scripts is
 * insane. Change the model so it doesn't cost me so much. Make sure it's
 * still a good model for this though."). Measured on 16 offline scripts, all
 * on Opus 5.5: $19.49, about $1.22 a script. Now:
 *   draft      Sonnet 5.5, high      revise   Sonnet 5.5, high (the one rewrite, a person's revision)
 *   brief      Sonnet 5.5, medium    review   Sonnet 5.5, medium
 *   retrieval  Haiku 5.5, medium: finding her passages in a long transcript
 * v2.6: the hooks step (Opus 5.5, high) is gone: the draft writes the hook
 * with the rest of the script. Exact ids, no date suffix; every effort named.
 * The model is stamped on every ProgramAiRun (the answering model, as before).
 */
export const STEP_MODEL: Record<Step, string> = { retrieval: "claude-haiku-5-5", brief: "claude-sonnet-5-5", draft: "claude-sonnet-5-5", review: "claude-sonnet-5-5", revise: "claude-sonnet-5-5" };
/** The effort per step (v2.3, with STEP_MODEL): high for the draft and every rewrite or revision; medium for reading the sources, the brief and the review. */
export const STEP_EFFORT: Record<Step, AiEffort> = { retrieval: "medium", brief: "medium", draft: "high", review: "medium", revise: "high" };
/** Room for the thinking as well as the answer (thinking counts toward max_tokens). */
export const STEP_MAX_TOKENS: Record<Step, number> = { retrieval: 16_000, brief: 12_000, draft: 12_000, review: 8_000, revise: 12_000 };
const STEP_MIN_START_MS: Record<Step, number> = { retrieval: 75_000, brief: 60_000, draft: 60_000, review: 45_000, revise: 60_000 };
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
 * (heldBack: live_deal and the writer's passages; v2.5 also pickHook).
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
// Prepare: gather → retrieval → brief (v2.6: no hooks step)
// ---------------------------------------------------------------------------

export type Prepared = {
  g: Gathered;
  passages: WriterPassage[];
  excluded: { quote: string; source: string; reason: string }[];
  overview: string | null;
  /** The interviewer's lines on this topic (Oct 22 2026): what the video is meant to answer. */
  asked: AskedLine[];
  brief: TopicBrief;
  runs: { retrieval: string | null; brief: string | null; olderRetrieval?: string | null };
};

/**
 * Gather, then read. Oct 22 2026 (the listening fix): the retrieval runs in two
 * steps. First the topic's call(s) and the recorded excerpts; then her words
 * there (with the interviewer's question around them) choose the windows of
 * her OLDER calls, the facts the brief reads and her same-subject scripts
 * (sources.withHerWords), and a second retrieval reads those windows for what
 * they add. Both readings' passages go to the brief and the review alike.
 * v2.6: the brief is the last step before the draft (no hooks step).
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
  return { g, passages, excluded, overview, asked: got.asked, brief, runs: { retrieval: retrievalRun, brief: b.runId, olderRetrieval: olderRun } };
}

/** THE DRAFT (v2.6): ONE call writes all five parts. The run a queued click adopts, holding the script's dedupe key until the version is written. */
export async function runDraftStep(p: Prepared, o: { requestedBy: string; unattended: boolean; deadline?: number | null; claimedRun?: ClaimedRun | null; dedupeKey: string; scope: Record<string, unknown> }) {
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: o.scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, inputRefs: { ...p.g.inputRefs, passages: p.passages.length, briefRunId: p.runs.brief } };
  return runWriterStep<DraftOut>("draft", buildDraftPrompt(p.g.ctx, p.brief, p.passages), rc, { dedupeKey: o.dedupeKey, holdDedupeKey: true, claimedRun: o.claimedRun ?? null, reuse: false });
}

/** The writer's answer in the shape every version is written from (contentGeneration.partsFromGenerated). `chosenHook` (a hook chosen before the draft, v2.2 to v2.5) is put back word for word when given; v2.6 writes it in the draft. */
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

/** What is stored with the version (validationJson.writer). v2.6: no hooks step, so no scored hooks. */
export function writerRecordOf(p: Prepared, draft: { output: DraftOut; runId: string }, asOf: Date | null = null): WriterRecord {
  return {
    v: 2, version: WRITER_VERSION, brief: p.brief, passages: p.passages, excludedPassages: p.excluded, hooks: [], chosen: -1, hookFallback: null, rationale: rationaleOf(draft.output),
    facts: p.g.ctx.facts, sources: p.g.labels, runs: { retrieval: p.runs.retrieval, brief: p.runs.brief, hooks: null, draft: draft.runId, ...(p.runs.olderRetrieval ? { olderRetrieval: p.runs.olderRetrieval } : {}) }, asOf: asOf?.toISOString() ?? null,
  };
}

/** A script's five parts as the rewrite and the review read them (HOOK, RE-HOOK, BUILD-UP, PAYOFF, CLOSE). Pure. */
export function partsText(parts: ScriptParts): string {
  return partsBlock({ hook: parts.hook, rehook: partTextOf(parts, "rehook"), buildup: partTextOf(parts, "buildup"), payoff: partTextOf(parts, "payoff"), close: parts.close });
}

// ---------------------------------------------------------------------------
// The review (v2.6): the viewer's read first, then code's hard checks
// ---------------------------------------------------------------------------

/**
 * A review's result. v2.6: `reads`, the reviewer's 1 to 10 read as a viewer
 * (it decides which of two versions reads better); `fixInstruction`, its one
 * note for the rewrite; `craft` is null (the part-by-part scores are gone).
 * `story`: the brief marks a told personal story (it may use up to the cap).
 */
export type ReviewResult = { checks: ReviewCheckResult[]; hard: HardFinding[]; mustFails: ReviewCheckResult[]; craft: CraftScores | null; reads: number | null; fixInstruction: string | null; summary: string | null; words: number; seconds: number; runId: string; story?: boolean };

/** What she said or approved, as the hard numbers read it (never our assumptions); v2.1: the whole call too. */
export function clientTextOf(rec: Pick<WriterRecord, "passages" | "facts">, ctx: Pick<WriterContext, "answers" | "strategyText" | "relatedScripts">, callText = ""): string {
  return [...rec.passages.flatMap((p) => [p.quote, p.context]), ...rec.facts.map((f) => f.body), ...ctx.answers.map((a) => a.answer), ...ctx.relatedScripts.map((r) => r.text), ctx.strategyText ?? "", callText].join("\n");
}

/** What she SAID out loud (the passages and the whole call): the text a pasted sentence is looked for in. */
export function spokenSourceOf(rec: Pick<WriterRecord, "passages">, callText = ""): string {
  return [...rec.passages.flatMap((p) => [p.quote, p.context]), callText].join("\n");
}

/**
 * The reviewer's answer, read (v2.6, pure): its four answers as the merge
 * reads them (a question it did not answer is left out, so it fails as "not
 * answered"), the 1 to 10 read (null when missing), the note and the summary.
 */
export function readViewerReview(out: ReviewOut | null | undefined): { answers: { key: string; pass?: boolean; reason?: string }[]; reads: number | null; note: string | null; summary: string | null } {
  const o = (out ?? {}) as Record<string, unknown>;
  const answers: { key: string; pass?: boolean; reason?: string }[] = [];
  for (const key of VIEWER_CHECK_KEYS) {
    const a = o[key] as { pass?: unknown; reason?: unknown } | null | undefined;
    if (!a || typeof a !== "object") continue;
    answers.push({ key, ...(typeof a.pass === "boolean" ? { pass: a.pass } : {}), ...(typeof a.reason === "string" ? { reason: a.reason } : {}) });
  }
  const reads = typeof o.reads === "number" && Number.isFinite(o.reads) ? Math.max(1, Math.min(10, Math.round(o.reads))) : null;
  const text = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  return { answers, reads, note: text(o.note, 3000) || null, summary: text(o.summary, 600) || null };
}

/**
 * THE REVIEW (v2.6). Code reads the script first (the hard numbers), the
 * reviewer reads it as a viewer (it is not shown code's findings), and the
 * two are merged: the reviewer's four answers, then code's checks.
 */
export async function reviewParts(ctx: WriterContext, rec: WriterRecord, parts: ScriptParts, rc: RunCtx, opts: { dedupeKey?: string | null; callText?: string | null } = {}): Promise<ReviewResult> {
  const callText = opts.callText ?? "";
  const story = rec.brief.videoType === "story";
  // v2.5: code fails a script that tells the live deal the brief keeps out (live_deal).
  const numbers = hardNumbers(parts, clientTextOf(rec, ctx, callText), spokenSourceOf(rec, callText), { story, liveDeal: liveDealOf(rec.brief), kept: keptTextOf(rec.brief), agreedFormat: agreedFormatOf(rec.brief) });
  const prompt = buildReviewPrompt({ ...ctx, facts: rec.facts }, rec.brief, rec.passages, { body: partsText(parts) }, callText);
  // Every version gets its own review run (never a reused verdict): the ledger shows each one.
  const r = await runWriterStep<ReviewOut>("review", prompt, rc, { dedupeKey: opts.dedupeKey ?? null, reuse: false });
  const v = readViewerReview(r.output);
  const checks = mergeViewerReview(v.answers, numbers.findings, numbers.words, { story });
  const mustFails = mustFixFailures(checks);
  return { checks, hard: numbers.findings, mustFails, craft: null, reads: v.reads, fixInstruction: mustFails.length ? v.note : null, summary: v.summary, words: numbers.words, seconds: numbers.seconds, runId: r.runId, story };
}

/**
 * After a review (v2.6; the automatic check on the version trail and the
 * offline run follow the same order): nothing must-fix failing → pass; a
 * must-fix failure (the reviewer's read or a hard check) and no rewrite yet
 * → the ONE whole rewrite; a rewrite already spent → flagged for Jordan
 * (quietly: the card never says so), with the version that reads better
 * current. Advice (a flag) never asks for a rewrite. Pure.
 */
export type WriterStep = "pass" | "rewrite" | "flag";
export function nextWriterStep(o: { mustFails: readonly unknown[]; rewrites: number }): WriterStep {
  if (!o.mustFails.length) return "pass";
  return o.rewrites < MAX_REWRITES ? "rewrite" : "flag";
}

/**
 * What the one whole rewrite is told (v2.6, pure): the reviewer's note as a
 * viewer first, then each must-fix check that failed in its own words. It
 * names what is wrong with the script, never a part to patch.
 */
export function rewriteInstruction(j: { checks?: readonly ReviewCheckResult[] | null; fixInstruction?: string | null }): string {
  const must = (j.checks ?? []).filter((c) => !c.pass && c.level === "must-fix");
  return [
    j.fixInstruction?.trim() ? `The reviewer, reading it as a viewer: ${j.fixInstruction.trim()}` : "",
    must.length ? `What failed:\n${must.map((c) => `- ${c.label}: ${c.reason}`).join("\n")}` : "",
    "Use only her sources: never invent a story, a number, a quote or a reason to fix it.",
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
export async function reviewVersion(versionId: string, o: { requestedBy: string; unattended: boolean; deadline?: number | null }): Promise<ReviewResult> {
  const v = await prisma.contentScriptVersion.findUnique({ where: { id: versionId } });
  if (!v) throw new Error("Version not found.");
  const s = await prisma.contentScript.findUnique({ where: { id: v.scriptId }, select: { id: true, topicId: true, monthId: true, enrollmentId: true, clientId: true } });
  if (!s) throw new Error("Script not found.");
  const rec = readWriter(v.validationJson) ?? (await latestWriterRecord(s.id));
  if (!rec) throw new Error("This version has no topic brief to review against.");
  const { ctx, callText } = await contextForScript(s, rec);
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline ?? null, scope: { scriptId: s.id, versionId }, enrollmentId: s.enrollmentId, clientId: s.clientId, strategyVersionId: v.strategyVersionId, policyVersionId: v.policyVersionId, inputRefs: { versionId, briefRunId: rec.runs.brief } };
  return reviewParts(ctx, rec, partsOfVersion(v), rc, { dedupeKey: `review:${versionId}`, callText });
}

/**
 * The prompt that revises a script the writer drafted (v2.6). `rewrite`: the
 * ONE whole rewrite after a failed review (the version and why, then the whole
 * script again; nothing locked, nothing copied back). Otherwise a person's or
 * a client's revision, or a person's length trim: the current version and the
 * instruction, with any parts the person locked.
 */
export async function writerRevisePrompt(s: { id: string; topicId: string | null; monthId: string | null }, rec: WriterRecord, current: { versionNo: number; body: string; parts?: ScriptParts | null }, instruction: string, opts: { lockedLabels?: string[]; who: "rewrite" | "trim" | "person" | "client" }): Promise<StepPrompt> {
  const { ctx } = await contextForScript(s, rec);
  if (opts.who === "rewrite") return buildRewritePrompt(ctx, rec.brief, rec.passages, { versionNo: current.versionNo, body: current.parts ? partsText(current.parts) : current.body }, instruction);
  return buildReviseWriterPrompt(ctx, rec.brief, rec.passages, current, instruction, { lockedLabels: opts.lockedLabels, who: opts.who });
}

// ---------------------------------------------------------------------------
// PHASE 3's OFFLINE RUN: the whole pipeline on one topic, as of a moment in
// the past, with nothing written but the AI run rows (scope offline: true).
// No script, no version, no portal, no message. For the go / no-go test.
// v2.6: the same steps as a real draft: the draft, its review, and when it
// fails the one whole rewrite and its review; the result is the one that
// reads better (rules.isBetterAttempt).
// ---------------------------------------------------------------------------

export type OfflineAttempt = { label: string; parts: ScriptParts; closeType: string | null; words: number; seconds: number; review: ReviewResult | null; note?: string | null };

export async function draftOffline(o: { topicId: string; monthId: string | null; asOf?: Date | null; requestedBy: string; callRecordId?: string | null }): Promise<{ prepared: Omit<Prepared, "g">; record: WriterRecord; attempts: OfflineAttempt[]; final: OfflineAttempt; state: "passed" | "flagged"; keptLonger: boolean }> {
  const p = await prepareDraft({ topicId: o.topicId, monthId: o.monthId, callRecordId: o.callRecordId ?? null, asOf: o.asOf ?? null, requestedBy: o.requestedBy, unattended: false, offline: true });
  const scope = { topicId: o.topicId, monthId: o.monthId, offline: true, asOf: o.asOf?.toISOString() ?? null };
  const rc: RunCtx = { requestedBy: o.requestedBy, unattended: false, scope, enrollmentId: p.g.enrollmentId, clientId: p.g.clientId, strategyVersionId: p.g.strategyVersionId, policyVersionId: p.g.policyVersionId, inputRefs: p.g.inputRefs };
  const draft = await runWriterStep<DraftOut>("draft", buildDraftPrompt(p.g.ctx, p.brief, p.passages), rc);
  const rec = writerRecordOf(p, draft, o.asOf ?? null);
  const story = p.brief.videoType === "story";
  const toParts = (out: DraftOut): { parts: ScriptParts; closeType: string | null } => { const j = generatedFromDraft(out, null, p.g.ctx.topic.pillar); return { parts: { hook: j.hook, points: j.points.map((x) => ({ role: String(x.role), text: x.text })), close: j.close }, closeType: out?.closeType ?? null }; };
  const attempts: OfflineAttempt[] = [];
  const reviewed = async (label: string, cur: { parts: ScriptParts; closeType: string | null }): Promise<OfflineAttempt & { review: ReviewResult }> => {
    const review = await reviewParts(p.g.ctx, rec, cur.parts, rc, { callText: p.g.callText });
    const a = { label, parts: cur.parts, closeType: cur.closeType, words: review.words, seconds: review.seconds, review };
    attempts.push(a);
    return a;
  };
  const first = await reviewed("draft", toParts(draft.output));
  if (nextWriterStep({ mustFails: first.review.mustFails, rewrites: 0 }) === "pass") return { prepared: strip(p), record: rec, attempts, final: first, state: "passed", keptLonger: false };
  // The one whole rewrite, with the reviewer's note and code's reasons.
  const rw = await runWriterStep<DraftOut>("revise", buildRewritePrompt(p.g.ctx, p.brief, p.passages, { versionNo: 1, body: partsText(first.parts) }, rewriteInstruction({ checks: first.review.checks, fixInstruction: first.review.fixInstruction })), rc);
  const second = await reviewed("rewrite", toParts(rw.output));
  // The one that reads better (the version trail's rule: the rewrite only when it is better).
  const score = (a: { review: ReviewResult; words: number }) => ({ mustFix: a.review.mustFails.length, reads: a.review.reads, words: a.words, story });
  const final = isBetterAttempt(score(second), score(first)) ? second : first;
  return { prepared: strip(p), record: rec, attempts, final, state: final.review.mustFails.length ? "flagged" : "passed", keptLonger: false };
}
const strip = (p: Prepared): Omit<Prepared, "g"> => { const { g: _g, ...rest } = p; void _g; return rest; };
