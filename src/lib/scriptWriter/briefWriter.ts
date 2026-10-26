import "server-only";
// ---------------------------------------------------------------------------
// THE BRIEF WRITER (Oct 26 2026): step two of Jordan's own workflow. One model
// call writes one topic's script from that topic's summary of what the agent
// said (topicBrief.ts), with his Scripting GPT's instructions and files as the
// standard (briefWriterPrompt.ts). No passage hunt, no hooks round, no review
// and rewrite rounds: the summary carries the substance, the GPT's standard
// carries the craft, and Jordan reviews the draft as he always has.
//
// Switched per client by AppSetting `script_brief_writer`:
//   {"on": true}                        every client
//   {"on": true, "enrollmentIds": [..]} those clients only
// Off (or unreadable) = the writers that ran before, untouched. Drafts route
// here from contentGeneration.routeScriptDraft; a script this writer drafted
// is revised here too (contentGeneration.reviseScript).
//
// Length (Jordan, Oct 26 2026: "that's not a firm rule; I just want them to be
// less than 100 words"): the writer is shown his Scripting GPT's own scripts
// (about 70) as the feel; a draft or revision of 100 spoken words or more goes
// back to the same writer with its count (fitToLength, at most two more calls;
// the shortest is kept).
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { runAiJson, type ClaimedRun } from "@/lib/aiRuns";
import { renderStrategy, creativeIdentityBlock, type GeneratedScriptJson } from "@/lib/contentPolicy";
import { countSpokenWords } from "@/lib/contentPolicy/policy";
import { skitCastBlock } from "@/lib/contentPolicy/prompts";
import { barExamplesFor } from "./barExamples";
import { BRIEF_SCRIPT_SCHEMA, LENGTH, briefWriterSystem, briefWriterUser, fitInstruction, scriptAsText } from "./briefWriterPrompt";
import { JORDAN_GPT_SCRIPTS, JORDAN_GPT_SCRIPTS_CLIENT } from "./houseReference";
import { BRIEF_MODEL, ensureTopicBrief, monthChosenTopics, currentBriefs, type BriefRow } from "./topicBrief";
import { topicBriefText } from "./briefFormat";

/** The summary as the writer reads it: the office's edit as written, else the AI's without the agent's verbatim lines. */
function writerBriefText(b: BriefRow): string {
  return b.edited || !b.brief ? b.text : topicBriefText(b.brief, undefined, { herWords: false });
}

export const BRIEF_WRITER_SWITCH = "script_brief_writer";
export const BRIEF_WRITER_VERSION = "brief-writer.v3";
/** validationJson key on a version this writer wrote. */
export const BRIEF_WRITER_KEY = "briefWriter";

export async function briefWriterOnFor(enrollmentId: string): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: BRIEF_WRITER_SWITCH }, select: { value: true } });
    if (!row?.value) return false;
    const v = JSON.parse(row.value) as { on?: unknown; enrollmentIds?: unknown };
    if (v.on !== true) return false;
    return !Array.isArray(v.enrollmentIds) || v.enrollmentIds.includes(enrollmentId);
  } catch {
    return false;
  }
}

export type BriefScriptOut = { title: string; category: string; hook: string; points: string[]; close: string; captionCta: string | null; production: string | null };

export class NothingToWriteFromError extends Error {
  constructor(title: string) { super(`"${title}" was not discussed on the call and has no written answers yet, so there is nothing of the agent's to write it from.`); this.name = "NothingToWriteFromError"; }
}

/** Spoken words as Jordan counts them: hook, the talking points, close (a skit's speaker names and stage directions are not said). */
export function briefSpokenWords(o: { hook: string; points: string[]; close: string }, skit: boolean): number {
  const said = (t: string) => (skit ? t.replace(/\([^)]*\)/g, " ").replace(/(^|[\n.!?]\s*)[A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,2}\s*:\s/g, "$1") : t);
  return [o.hook, ...(o.points ?? []), o.close].reduce((n, t) => n + countSpokenWords(said(t ?? "")), 0);
}

/** How far a count is over LENGTH.cut (0 = fine as it is). */
const offTarget = (n: number) => Math.max(0, n - LENGTH.cut);
const FIT_TRIES = 2;
export type LengthFit = { from: number; to: number; runIds: string[] };

/**
 * A script over LENGTH.cut spoken words goes back to the writer with its
 * count, at most twice; the shortest is kept. A failed or
 * late call leaves the best so far (the card shows its length as always).
 */
export async function fitToLength(first: BriefScriptOut, o: { skit: boolean; prompt: string; deadline: number | null; call: (prompt: string, attempt: number) => Promise<{ output: BriefScriptOut; runId: string }> }): Promise<{ output: BriefScriptOut; fit: LengthFit | null }> {
  const from = briefSpokenWords(first, o.skit);
  let best = first;
  let bestN = from;
  const runIds: string[] = [];
  for (let i = 1; i <= FIT_TRIES && offTarget(bestN) > 0; i++) {
    if (o.deadline && o.deadline - Date.now() < 60_000) break;
    try {
      const r = await o.call(`${o.prompt}\n\nYOUR SCRIPT:\n${scriptAsText(best)}\n\n${fitInstruction(bestN, o.skit)}`, i);
      runIds.push(r.runId);
      const n = briefSpokenWords(r.output, o.skit);
      if (offTarget(n) < offTarget(bestN)) { best = r.output; bestN = n; }
    } catch {
      break;
    }
  }
  return { output: best, fit: runIds.length ? { from, to: bestN, runIds } : null };
}

const ROLES = ["re-hook", "build-up", "payoff"] as const;
export function generatedFromBriefScript(o: BriefScriptOut, fallbackCategory: string): GeneratedScriptJson {
  return {
    title: o.title, category: o.category?.trim() || fallbackCategory, hook: o.hook,
    points: (o.points ?? []).slice(0, 3).map((text, i) => ({ role: ROLES[i], text })),
    close: o.close, captionCta: o.captionCta ?? null, filmingNotes: o.production ?? null,
  };
}

type WriterCtx = { clientName: string; strategy: string | null; voice: string | null; cast: string | null; good: { title: string; text: string }[]; examples: { title: string; text: string }[]; otherTopics: string[]; priority: string | null; strategyVersionId: string | null; policyVersionId: string | null };

/** Jordan's Scripting GPT scripts, as the writer is shown them; never to the agent they were written for. */
function goodScriptsFor(clientName: string): { title: string; text: string }[] {
  if (clientName.trim().toLowerCase() === JORDAN_GPT_SCRIPTS_CLIENT.toLowerCase()) return [];
  return JORDAN_GPT_SCRIPTS.map((g) => ({ title: g.title, text: `${scriptAsText({ hook: g.hook, points: g.points, close: g.close, captionCta: g.captionCta })}\n(${briefSpokenWords(g, false)} spoken words)` }));
}

async function writerContext(o: { enrollmentId: string; monthId: string | null; topicId: string | null; title: string; excludeScriptId?: string | null }): Promise<WriterCtx> {
  const gen = await import("@/lib/contentGeneration");
  const built = await gen.buildClientContext(o.enrollmentId, { monthId: o.monthId, excludeScriptId: o.excludeScriptId ?? null });
  const doc = built.ctx.strategy?.document ?? null;
  let strategy = doc ? renderStrategy(doc, { preserveSourceHeadings: true }) : null;
  if (strategy && strategy.length > 14_000) strategy = `${strategy.slice(0, 14_000)} ...`;
  let voice = creativeIdentityBlock(built.ctx.creativeIdentity) || null;
  if (voice && voice.length > 3500) voice = `${voice.slice(0, 3500)} ...`;
  // Only the sent scripts near Jordan's length: a long one would pull the draft long.
  const bar = (await barExamplesFor({ enrollmentId: o.enrollmentId, topicTitle: o.title }))
    .filter((b) => briefSpokenWords({ hook: b.hook, points: [b.rehook, b.buildup, b.payoff], close: b.close }, false) <= 80);
  const others = o.monthId ? (await monthChosenTopics(o.monthId)).topics.filter((t) => t.id !== o.topicId).map((t) => t.title) : [];
  // The month's main request, for his rules' buyer and seller balance.
  const priority = o.monthId ? (await currentBriefs(o.monthId)).header?.header?.mainRequest ?? null : null;
  return {
    clientName: built.ctx.clientName, strategy, voice, cast: skitCastBlock(built.ctx.skitCast) || null, good: goodScriptsFor(built.ctx.clientName),
    examples: bar.map((b) => ({ title: b.title, text: [`HOOK: ${b.hook}`, `TALKING POINT 1: ${b.rehook}`, `TALKING POINT 2: ${b.buildup}`, `TALKING POINT 3: ${b.payoff}`, `CLOSE: ${b.close}`].join("\n") })),
    otherTopics: others, priority, strategyVersionId: built.strategyVersionId ?? null, policyVersionId: built.policyVersionId ?? null,
  };
}

function userPrompt(ctx: WriterCtx, briefText: string, skit: boolean): string {
  const base = briefWriterUser({ clientName: ctx.clientName, briefText, strategy: ctx.strategy, voice: ctx.voice, good: ctx.good, priority: ctx.priority, examples: ctx.examples, otherTopics: ctx.otherTopics, skit });
  return skit && ctx.cast ? base.replace("THE SUMMARY OF WHAT", `${ctx.cast}\n\nTHE SUMMARY OF WHAT`) : base;
}

export type BriefDraftOpts = {
  topicId: string; monthId: string; enrollmentId: string; clientId: string; title: string; category: string; skit: boolean;
  requestedBy: string; unattended: boolean; claimedRun: ClaimedRun | null; dedupeKey: string; scope: Record<string, unknown>; deadline: number | null;
};

/** One topic's script from its summary: the model's answer, the run, and the summary it read. */
export async function runBriefDraft(o: BriefDraftOpts): Promise<{ brief: BriefRow; json: GeneratedScriptJson; output: BriefScriptOut; runId: string; fit: LengthFit | null; strategyVersionId: string | null; policyVersionId: string | null }> {
  const brief = await ensureTopicBrief(o.topicId, o.monthId, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline });
  if (!brief || (!brief.edited && brief.brief && !brief.brief.discussed)) throw new NothingToWriteFromError(o.title);
  const ctx = await writerContext({ enrollmentId: o.enrollmentId, monthId: o.monthId, topicId: o.topicId, title: o.title });
  const prompt = userPrompt(ctx, writerBriefText(brief), o.skit);
  const call = (p: string, fitAttempt: number | null) => runAiJson<BriefScriptOut>({
    kind: "script_draft", engine: "writer", model: BRIEF_MODEL, effort: "high", maxTokens: 3000,
    enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { ...o.scope, briefWriter: true, ...(fitAttempt ? { lengthFit: fitAttempt } : {}) },
    inputRefs: { briefId: brief.id, briefEdited: brief.edited, goodExampleTitles: ctx.good.map((e) => e.title), barExampleTitles: ctx.examples.map((e) => e.title), strategyVersionId: ctx.strategyVersionId },
    promptKey: fitAttempt ? "script.brief_writer.fit" : "script.brief_writer", promptVersion: BRIEF_WRITER_VERSION, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId,
    requestedBy: o.requestedBy, unattended: o.unattended,
    // The first call holds the script's key until the version is written; a length pass is its own short run.
    ...(fitAttempt ? { dedupeKey: `${o.dedupeKey}:fit${fitAttempt}`, claimedRun: null } : { dedupeKey: o.dedupeKey, holdDedupeKey: true, claimedRun: o.claimedRun }),
    system: briefWriterSystem(), prompt: p, schema: BRIEF_SCRIPT_SCHEMA as unknown as Record<string, unknown>,
    ...(o.deadline ? { timeoutMs: Math.max(30_000, o.deadline - Date.now()) } : {}),
  });
  const run = await call(prompt, null);
  const fitted = await fitToLength(run.output, { skit: o.skit, prompt: prompt.replace(/\n\nWrite the script for this topic\.$/, ""), deadline: o.deadline, call: (p, i) => call(p, i) });
  return { brief, json: generatedFromBriefScript(fitted.output, o.category), output: fitted.output, runId: run.runId, fit: fitted.fit, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId };
}

/** Did this writer draft (any version of) the script? Then its revisions are written here too. */
export async function briefWrittenScript(scriptId: string): Promise<boolean> {
  const n = await prisma.contentScriptVersion.count({ where: { scriptId, validationJson: { contains: `"${BRIEF_WRITER_KEY}":` } } });
  return n > 0;
}

/** A revision of a script this writer drafted: the same standard, the topic's summary, the current script and the change asked for. */
export async function runBriefRevise(o: {
  scriptId: string; monthId: string | null; topicId: string | null; enrollmentId: string; clientId: string; title: string; category: string; skit: boolean;
  current: { hook: string; points: string[]; close: string; captionCta: string | null };
  instruction: string; lockedLabels: string[]; who: "person" | "client" | "rewrite" | "trim";
  requestedBy: string; unattended: boolean; claimedRun: ClaimedRun | null; deadline: number | null;
}): Promise<{ json: GeneratedScriptJson; output: BriefScriptOut; runId: string; briefId: string | null; fit: LengthFit | null }> {
  const brief = o.monthId && o.topicId ? (await currentBriefs(o.monthId)).byTopic.get(o.topicId) ?? null : null;
  const ctx = await writerContext({ enrollmentId: o.enrollmentId, monthId: o.monthId, topicId: o.topicId, title: o.title, excludeScriptId: o.scriptId });
  const asked = o.who === "client" ? "THE CLIENT ASKED FOR THIS CHANGE" : o.who === "trim" ? "MAKE IT SHORTER" : "JORDAN ASKED FOR THIS CHANGE";
  const prompt = [
    userPrompt(ctx, brief ? writerBriefText(brief) : "(No summary on file for this topic: keep to what the current script already says.)", o.skit).replace(/\n\nWrite the script for this topic\.$/, ""),
    `THE CURRENT SCRIPT:\n${scriptAsText({ title: o.title, ...o.current })}`,
    `${asked}:\n${o.instruction.trim()}`,
    o.lockedLabels.length ? `Keep these parts word for word: ${o.lockedLabels.join(", ")}.` : "",
    "Rewrite the script with that change. Change what the request asks for and what it needs to read well; keep the rest. Everything else in your standard still applies.",
  ].filter(Boolean).join("\n\n");
  const call = (p: string, fitAttempt: number | null) => runAiJson<BriefScriptOut>({
    kind: "script_revise", engine: "writer", model: BRIEF_MODEL, effort: "high", maxTokens: 3000,
    enrollmentId: o.enrollmentId, clientId: o.clientId, scope: { scriptId: o.scriptId, briefWriter: true, who: o.who, ...(fitAttempt ? { lengthFit: fitAttempt } : {}) },
    inputRefs: { briefId: brief?.id ?? null, instructionText: o.instruction.slice(0, 20_000) },
    promptKey: fitAttempt ? "script.brief_writer.fit" : "script.brief_writer.revise", promptVersion: BRIEF_WRITER_VERSION, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId,
    requestedBy: o.requestedBy, unattended: o.unattended, dedupeKey: fitAttempt ? `revise:${o.scriptId}:fit${fitAttempt}` : `revise:${o.scriptId}`, claimedRun: fitAttempt ? null : o.claimedRun,
    system: briefWriterSystem(), prompt: p, schema: BRIEF_SCRIPT_SCHEMA as unknown as Record<string, unknown>,
    ...(o.deadline ? { timeoutMs: Math.max(30_000, o.deadline - Date.now()) } : {}),
  });
  const run = await call(prompt, null);
  const fitted = await fitToLength(run.output, { skit: o.skit, prompt, deadline: o.deadline, call: (p, i) => call(p, i) });
  return { json: generatedFromBriefScript(fitted.output, o.category), output: fitted.output, runId: run.runId, briefId: brief?.id ?? null, fit: fitted.fit };
}
