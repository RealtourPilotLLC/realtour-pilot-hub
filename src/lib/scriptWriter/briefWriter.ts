import "server-only";
// ---------------------------------------------------------------------------
// THE BRIEF WRITER (Oct 26 2026): step two of Jordan's own workflow. One model
// call writes one topic's script from that topic's summary of what the agent
// said (topicBrief.ts), the way his Scripting GPT does (briefWriterPrompt.ts:
// his GPT's instructions, his additional rules, his GPT's Erica scripts as how
// a script reads), in his GPT's own output format. Then his rule 6: a second
// call checks structure, word count (the hub's count), source accuracy and
// spoken delivery, and returns the script as it was or fixed (checkBeforeSubmit).
// No passage hunt, no hooks round; Jordan reviews the draft as he always has.
//
// Switched per client by AppSetting `script_brief_writer`:
//   {"on": true}                        every client
//   {"on": true, "enrollmentIds": [..]} those clients only
// Off (or unreadable) = the writers that ran before, untouched. Drafts route
// here from contentGeneration.routeScriptDraft (direct to camera only); a
// script this writer drafted is revised here too (contentGeneration.reviseScript).
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { runAiJson, releaseRunKey, type ClaimedRun } from "@/lib/aiRuns";
import { creativeIdentityBlock, type GeneratedScriptJson, type StrategyDocument } from "@/lib/contentPolicy";
import { countSpokenWords } from "@/lib/contentPolicy/policy";
import { skitCastBlock } from "@/lib/contentPolicy/prompts";
import { noDashes } from "@/lib/text";
import { BRIEF_SCRIPT_SCHEMA, CHECK_SCHEMA, LENGTH, briefWriterSystem, briefWriterUser, checkerSystem, checkPrompt, parseScriptFormat, scriptInFormat } from "./briefWriterPrompt";
import { JORDAN_GPT_SCRIPTS, JORDAN_GPT_SCRIPTS_CLIENT } from "./houseReference";
import { BRIEF_MODEL, ensureTopicBrief, monthChosenTopics, currentBriefs, type BriefRow } from "./topicBrief";
import { topicBriefText } from "./briefFormat";

/** The summary as the writer reads it: the office's edit as written, else the AI's, with the agent's strongest lines (his rule 2). */
function writerBriefText(b: BriefRow): string {
  return b.edited || !b.brief ? b.text : topicBriefText(b.brief);
}

export const BRIEF_WRITER_SWITCH = "script_brief_writer";
export const BRIEF_WRITER_VERSION = "brief-writer.v4";
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

/** The writer's answer was not a script in his GPT's format (no hook, three talking points and close to read). */
export class ScriptFormatError extends Error {
  constructor() { super("The writer's answer wasn't a script in the usual format (hook, three talking points, close). Try drafting it again."); this.name = "ScriptFormatError"; }
}

/** Spoken words as Jordan counts them: hook, the talking points, close (a skit's speaker names and stage directions are not said). */
export function briefSpokenWords(o: { hook: string; points: string[]; close: string }, skit: boolean): number {
  const said = (t: string) => (skit ? t.replace(/\([^)]*\)/g, " ").replace(/(^|[\n.!?]\s*)[A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,2}\s*:\s/g, "$1") : t);
  return [o.hook, ...(o.points ?? []), o.close].reduce((n, t) => n + countSpokenWords(said(t ?? "")), 0);
}

/** A script in his GPT's format, read into its parts, never a dash. Null when it is not one. */
export function readBriefScript(text: string, fallbackTitle: string): BriefScriptOut | null {
  const p = parseScriptFormat(text);
  if (!p) return null;
  const d = (t: string) => noDashes(t).trim();
  return { title: d(p.title ?? fallbackTitle), category: d(p.category ?? ""), hook: d(p.hook), points: p.points.map(d), close: d(p.close), captionCta: p.captionCta ? d(p.captionCta) : null, production: p.production ? d(p.production) : null };
}

type WriterRaw = { script: string };
type CheckRaw = { verdict: string; issues: string[]; script: string };
/** What the check did: the count before and after, its runs, verdicts and the issues it named. */
export type ScriptCheck = { from: number; to: number; runIds: string[]; verdicts: string[]; issues: string[] };

/**
 * HIS RULE 6: "Before submitting, independently check structure, word count,
 * source accuracy, and spoken delivery." One check always; a second only when
 * the script is still over LENGTH.again. A fixed script is taken unless it
 * reaches 100 words and is longer than what it fixed; a failed or late check
 * keeps the script as it stands (the card shows its length as always).
 */
export async function checkBeforeSubmit(first: BriefScriptOut, o: { skit: boolean; writerPrompt: string; deadline: number | null; call: (prompt: string, attempt: number) => Promise<{ output: CheckRaw; runId: string }> }): Promise<{ output: BriefScriptOut; check: ScriptCheck | null }> {
  const from = briefSpokenWords(first, o.skit);
  let best = first;
  let n = from;
  const runIds: string[] = [];
  const verdicts: string[] = [];
  const issues: string[] = [];
  for (let i = 1; i <= 2; i++) {
    if (i === 2 && n <= LENGTH.again) break;
    if (o.deadline && o.deadline - Date.now() < 60_000) break;
    try {
      const r = await o.call(checkPrompt({ writerPrompt: o.writerPrompt, script: scriptInFormat(best), words: n, again: i === 2 }), i);
      runIds.push(r.runId);
      verdicts.push(r.output?.verdict === "FIXED" ? "FIXED" : "PASS");
      issues.push(...(Array.isArray(r.output?.issues) ? r.output.issues : []).map((x) => noDashes(String(x)).slice(0, 200)).slice(0, 8));
      const next = readBriefScript(r.output?.script ?? "", best.title);
      if (!next) continue;
      const m = briefSpokenWords(next, o.skit);
      if (m <= LENGTH.hard || m <= n) { best = next; n = m; }
    } catch {
      break;
    }
  }
  return { output: best, check: runIds.length ? { from, to: n, runIds, verdicts, issues } : null };
}

const ROLES = ["re-hook", "build-up", "payoff"] as const;
export function generatedFromBriefScript(o: BriefScriptOut, fallbackCategory: string): GeneratedScriptJson {
  return {
    title: o.title, category: o.category?.trim() || fallbackCategory, hook: o.hook,
    points: (o.points ?? []).slice(0, 3).map((text, i) => ({ role: ROLES[i], text })),
    close: o.close, captionCta: o.captionCta ?? null, filmingNotes: o.production ?? null,
  };
}

type WriterCtx = { clientName: string; profile: string | null; voice: string | null; cast: string | null; good: { forClient: string; text: string; title: string }[]; otherTopics: string[]; priority: string | null; strategyVersionId: string | null; policyVersionId: string | null };

/** His GPT's Erica scripts in its own format; never the one written for this same topic. */
function goodScriptsFor(topicId: string | null): { forClient: string; text: string; title: string }[] {
  return JORDAN_GPT_SCRIPTS.filter((g) => g.topicId !== topicId).map((g, i) => ({ forClient: JORDAN_GPT_SCRIPTS_CLIENT, title: g.title, text: scriptInFormat({ ...g, production: null }, i + 1) }));
}

/** Market, audience and voice from their strategy: a few lines, not the document. */
function profileOf(doc: StrategyDocument | null | undefined): string | null {
  if (!doc) return null;
  const cut = (v: string | null | undefined, n = 400) => { const t = (v ?? "").replace(/\s+/g, " ").trim(); return t ? (t.length > n ? `${t.slice(0, n)} ...` : t) : null; };
  const rows: [string, string | null][] = [
    ["Market", cut(doc.targetAudience?.primaryServiceAreas)],
    ["Who they serve", cut(doc.targetAudience?.primaryClientTypes)],
    ["Price point", cut(doc.targetAudience?.pricePositioning, 200)],
    ["Brand voice", cut(doc.brandOverview?.brandVoice)],
    ["What they stand for", cut(doc.brandOverview?.shortBrandStatement ?? doc.brandOverview?.brandMessage)],
  ];
  const lines = rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  return lines.length ? lines.join("\n") : null;
}

async function writerContext(o: { enrollmentId: string; monthId: string | null; topicId: string | null; excludeScriptId?: string | null }): Promise<WriterCtx> {
  const gen = await import("@/lib/contentGeneration");
  const built = await gen.buildClientContext(o.enrollmentId, { monthId: o.monthId, excludeScriptId: o.excludeScriptId ?? null });
  let voice = creativeIdentityBlock(built.ctx.creativeIdentity) || null;
  if (voice && voice.length > 1500) voice = `${voice.slice(0, 1500)} ...`;
  const others = o.monthId ? (await monthChosenTopics(o.monthId)).topics.filter((t) => t.id !== o.topicId).map((t) => t.title) : [];
  // The month's main request, for his rules' buyer and seller balance.
  const priority = o.monthId ? (await currentBriefs(o.monthId)).header?.header?.mainRequest ?? null : null;
  return {
    clientName: built.ctx.clientName, profile: profileOf(built.ctx.strategy?.document), voice, cast: skitCastBlock(built.ctx.skitCast) || null, good: goodScriptsFor(o.topicId),
    otherTopics: others, priority, strategyVersionId: built.strategyVersionId ?? null, policyVersionId: built.policyVersionId ?? null,
  };
}

function userPrompt(ctx: WriterCtx, briefText: string, skit: boolean, topicTitle: string): string {
  return briefWriterUser({ clientName: ctx.clientName, profile: ctx.profile, voice: ctx.voice, priority: ctx.priority, good: ctx.good, otherTopics: ctx.otherTopics, skit, cast: ctx.cast, topicTitle, briefText });
}

export type BriefDraftOpts = {
  topicId: string; monthId: string; enrollmentId: string; clientId: string; title: string; category: string; skit: boolean;
  requestedBy: string; unattended: boolean; claimedRun: ClaimedRun | null; dedupeKey: string; scope: Record<string, unknown>; deadline: number | null;
};

const timeout = (deadline: number | null) => (deadline ? { timeoutMs: Math.max(30_000, deadline - Date.now()) } : {});

/** One topic's script from its summary, checked: the script, the writer's run, the check, and the summary it read. */
export async function runBriefDraft(o: BriefDraftOpts): Promise<{ brief: BriefRow; json: GeneratedScriptJson; output: BriefScriptOut; runId: string; check: ScriptCheck | null; strategyVersionId: string | null; policyVersionId: string | null }> {
  const brief = await ensureTopicBrief(o.topicId, o.monthId, { requestedBy: o.requestedBy, unattended: o.unattended, deadline: o.deadline });
  if (!brief || (!brief.edited && brief.brief && !brief.brief.discussed)) throw new NothingToWriteFromError(o.title);
  const ctx = await writerContext({ enrollmentId: o.enrollmentId, monthId: o.monthId, topicId: o.topicId });
  const prompt = userPrompt(ctx, writerBriefText(brief), o.skit, o.title);
  const common = { engine: "writer" as const, model: BRIEF_MODEL, effort: "high" as const, maxTokens: 3000, enrollmentId: o.enrollmentId, clientId: o.clientId, promptVersion: BRIEF_WRITER_VERSION, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId, requestedBy: o.requestedBy, unattended: o.unattended };
  // The writer's call holds the script's key until the version is written.
  const run = await runAiJson<WriterRaw>({
    ...common, kind: "script_draft", scope: { ...o.scope, briefWriter: true },
    inputRefs: { briefId: brief.id, briefEdited: brief.edited, goodExampleTitles: ctx.good.map((e) => e.title), strategyVersionId: ctx.strategyVersionId },
    promptKey: "script.brief_writer", dedupeKey: o.dedupeKey, holdDedupeKey: true, claimedRun: o.claimedRun,
    system: briefWriterSystem(), prompt, schema: BRIEF_SCRIPT_SCHEMA as unknown as Record<string, unknown>, ...timeout(o.deadline),
  });
  try {
    const draft = readBriefScript(run.output?.script ?? "", o.title);
    if (!draft) throw new ScriptFormatError();
    const checked = await checkBeforeSubmit(draft, {
      skit: o.skit, writerPrompt: prompt, deadline: o.deadline,
      call: (p, i) => runAiJson<CheckRaw>({ ...common, kind: "script_review", scope: { ...o.scope, briefWriter: true, check: i }, inputRefs: { briefId: brief.id, writerRunId: run.runId }, promptKey: "script.brief_writer.check", dedupeKey: `${o.dedupeKey}:check${i}`, claimedRun: null, system: checkerSystem(), prompt: p, schema: CHECK_SCHEMA as unknown as Record<string, unknown>, ...timeout(o.deadline) }),
    });
    return { brief, json: generatedFromBriefScript(checked.output, o.category), output: checked.output, runId: run.runId, check: checked.check, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId };
  } catch (e) {
    await releaseRunKey(run.runId);
    throw e;
  }
}

/** Did this writer draft (any version of) the script? Then its revisions are written here too. */
export async function briefWrittenScript(scriptId: string): Promise<boolean> {
  const n = await prisma.contentScriptVersion.count({ where: { scriptId, validationJson: { contains: `"${BRIEF_WRITER_KEY}":` } } });
  return n > 0;
}

/** A revision of a script this writer drafted: the same instructions, the topic's summary, the current script and the change asked for; checked like a draft. */
export async function runBriefRevise(o: {
  scriptId: string; monthId: string | null; topicId: string | null; enrollmentId: string; clientId: string; title: string; category: string; skit: boolean;
  current: { hook: string; points: string[]; close: string; captionCta: string | null };
  instruction: string; lockedLabels: string[]; who: "person" | "client" | "rewrite" | "trim";
  requestedBy: string; unattended: boolean; claimedRun: ClaimedRun | null; deadline: number | null;
}): Promise<{ json: GeneratedScriptJson; output: BriefScriptOut; runId: string; briefId: string | null; check: ScriptCheck | null }> {
  const brief = o.monthId && o.topicId ? (await currentBriefs(o.monthId)).byTopic.get(o.topicId) ?? null : null;
  const ctx = await writerContext({ enrollmentId: o.enrollmentId, monthId: o.monthId, topicId: o.topicId, excludeScriptId: o.scriptId });
  const asked = o.who === "client" ? "THE CLIENT ASKED FOR THIS CHANGE" : o.who === "trim" ? "MAKE IT SHORTER" : "JORDAN ASKED FOR THIS CHANGE";
  const prompt = [
    userPrompt(ctx, brief ? writerBriefText(brief) : "(No summary on file for this topic: keep to what the current script already says.)", o.skit, o.title).replace(/\n\nWrite Video 1: [^\n]*$/, ""),
    `THE CURRENT SCRIPT:\n${scriptInFormat({ title: o.title, category: o.category, ...o.current })}`,
    `${asked}:\n${o.instruction.trim()}`,
    o.lockedLabels.length ? `Keep these parts word for word: ${o.lockedLabels.join(", ")}.` : "",
    "Write it again with that change, in your exact output format. Change what the request asks for and what it needs to read well; keep the rest.",
  ].filter(Boolean).join("\n\n");
  const common = { engine: "writer" as const, model: BRIEF_MODEL, effort: "high" as const, maxTokens: 3000, enrollmentId: o.enrollmentId, clientId: o.clientId, promptVersion: BRIEF_WRITER_VERSION, strategyVersionId: ctx.strategyVersionId, policyVersionId: ctx.policyVersionId, requestedBy: o.requestedBy, unattended: o.unattended };
  const run = await runAiJson<WriterRaw>({
    ...common, kind: "script_revise", scope: { scriptId: o.scriptId, briefWriter: true, who: o.who },
    inputRefs: { briefId: brief?.id ?? null, instructionText: o.instruction.slice(0, 20_000) },
    promptKey: "script.brief_writer.revise", dedupeKey: `revise:${o.scriptId}`, claimedRun: o.claimedRun,
    system: briefWriterSystem(), prompt, schema: BRIEF_SCRIPT_SCHEMA as unknown as Record<string, unknown>, ...timeout(o.deadline),
  });
  const revised = readBriefScript(run.output?.script ?? "", o.title);
  if (!revised) throw new ScriptFormatError();
  const checked = await checkBeforeSubmit(revised, {
    skit: o.skit, writerPrompt: prompt, deadline: o.deadline,
    call: (p, i) => runAiJson<CheckRaw>({ ...common, kind: "script_review", scope: { scriptId: o.scriptId, briefWriter: true, check: i }, inputRefs: { briefId: brief?.id ?? null, writerRunId: run.runId }, promptKey: "script.brief_writer.check", dedupeKey: `revise:${o.scriptId}:check${i}`, claimedRun: null, system: checkerSystem(), prompt: p, schema: CHECK_SCHEMA as unknown as Record<string, unknown>, ...timeout(o.deadline) }),
  });
  return { json: generatedFromBriefScript(checked.output, o.category), output: checked.output, runId: run.runId, briefId: brief?.id ?? null, check: checked.check };
}
