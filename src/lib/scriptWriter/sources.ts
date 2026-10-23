import "server-only";
import { prisma } from "@/lib/prisma";
import { CONFIDENTIAL_RE, CONFIDENTIAL_PHRASE_RE, confidentialFilter } from "@/lib/clientFacts";
import { renderStrategy, creativeIdentityBlock } from "@/lib/contentPolicy";
import { creativeGuardBlock, discontinuedHit, type CreativeGuard } from "@/lib/creativeGuardCore";
import { segmentTranscript, topicKeywords, keywordHits, keywordWindows, isInternalTalk, herKeywords, transcriptBody, type TranscriptLine } from "./passages";
import { TEAM_REVIEWER, DROP_NOTE_PREFIX } from "./factCleanup";
import type { WriterContext, SourceDoc } from "./prompts";
import type { WriterFact } from "./record";

// ---------------------------------------------------------------------------
// WHAT THE WRITER READS (Oct 22 2026): everything about ONE topic of ONE
// client, gathered from the database before any model call.
//
//   the topic's call(s)   the confirmed transcript of the call this topic came
//                         from (the selection's call, the month's call, the
//                         script's call), IN FULL, for the retrieval step to
//                         read; the month's pasted transcript when that is all
//                         there is
//   older calls           her other calls and older month transcripts, as the
//                         few windows that mention this topic's words (bounded:
//                         eight windows at most), never every call ever held.
//                         Oct 22 2026 (the listening fix): the windows are
//                         chosen AFTER the topic's call is read, by HER words
//                         there (withHerWords below; pipeline.prepareDraft
//                         reads them in a second retrieval), never by the
//                         AI-written description; Gemini's notes are skipped
//   recorded excerpts     what the call analysis already quoted for the topic
//   written answers       her portal answers, when she answered in writing
//   facts                 accepted, AI-allowed facts, AND what she said on a
//                         call that nobody has reviewed yet (Jordan, Oct 22
//                         2026, decision 3: usable now, labelled "not reviewed
//                         yet"); never a fact for the team only (production,
//                         scheduling, billing, internal notes, reported
//                         performance, commitments), never a confidential one.
//                         Oct 22 2026 (the listening fix): an accepted fact
//                         filed under an OLDER month counts too when it is
//                         about her (history, process, opinions, service), not
//                         that month's plans; a fact is labelled "direction,
//                         never a line to say" only when it reads as one
//   scripts               her earlier filmed or approved scripts ON THE SAME
//                         SUBJECT (what she has said on camera), and voice
//                         examples chosen by subject, client-approved first,
//                         then office-approved, then filmed; a series the
//                         creative guard lists as discontinued is skipped;
//                         each labelled with why it is there
//   why chosen            how the topic reached the month (her pick, the call,
//                         the office), the pillar, the month's priorities
//
// Every text that reaches a prompt is scrubbed the way the other generators
// scrub: lines naming another enrolled client and anything confidential go
// (contentGeneration.scrubTranscriptForGeneration / scrubOtherClients /
// clientFacts.confidentialFilter).
//
// `asOf` (phase 3's offline test): only what existed at that moment is read:
// calls, transcripts, facts, scripts and the guard's discontinued series. The
// approved strategy, the creative identity and the month's priorities are read
// as they are now (they carry no history to read them back from).
// ---------------------------------------------------------------------------

export type GatherOpts = {
  topicId: string;
  monthId: string | null;
  callRecordId?: string | null;
  interviewId?: string | null;
  /** The script being revised or reviewed: never its own voice example. */
  excludeScriptId?: string | null;
  asOf?: Date | null;
  /**
   * The review and the revisions: the context and the topic's own call (so a
   * claim can be checked against everything she said), but no older calls and
   * no recorded excerpts. The passages travel with the version (validationJson.writer).
   */
  light?: boolean;
};

export type Gathered = {
  ctx: WriterContext;
  enrollmentId: string;
  clientId: string;
  pillarId: string | null;
  strategyVersionId: string | null;
  policyVersionId: string;
  /** The retrieval step's reading: full calls first, then older windows, then recorded excerpts. */
  sources: SourceDoc[];
  /** Each source's lines, to find the model's quotes in. */
  lines: Map<string, TranscriptLine[]>;
  /** For the hard numbers: everything she said or approved that the writer read (never our assumptions). */
  clientText: string;
  /**
   * The topic's own call(s) in full, labelled (Oct 22 2026, v2.1): the brief and
   * the review check what she said against ALL of it, not only the passages
   * (the seniors test excluded her central line as "only in the summary").
   */
  callText: string;
  keywords: string[];
  /** Hold back a passage: confidential, or naming another client. */
  holdBack: (text: string) => Promise<boolean>;
  labels: { calls: string[]; olderWindows: number; relatedScripts: string[]; voiceRefs: { title: string; why: string }[]; answers: number };
  inputRefs: Record<string, unknown>;
  videoStyle: "DIRECT" | "SKITS";
  /**
   * Oct 22 2026 (the listening fix). Her older calls, scrubbed, from the
   * "Transcript" heading down, not yet cut into windows: withHerWords chooses
   * the windows by her words once the topic's call has been read.
   */
  olderDocs: OlderDoc[];
  /** Every fact the writer may use (scrubbed, labelled), before they are ranked by her words and numbered. */
  factPool: PoolFact[];
  /** Her scripts the writer may read, before they are picked by her words. */
  scriptCands: ScriptCandidate[];
  guard: CreativeGuard | null;
  /** The topic's title and her own words outside the call (quotable lines, written answers): what her keywords start from. */
  herWords: string[];
};

export type OlderDoc = { label: string; lines: TranscriptLine[] };
export type PoolFact = WriterFact & { factId: string; score?: number; at?: number };

const FULL_CALL_CHARS = 150_000;
const OLDER_WINDOWS_MAX = 8;
const FACTS_MAX = 30;
/** How many candidate facts are kept before her words rank them. */
const FACT_POOL_MAX = 80;

/** Fact categories that are never for a buyer or seller: they stay with the team. */
export const TEAM_ONLY_CATEGORIES = new Set(["PRODUCTION_PREFERENCE", "INTERNAL", "PERFORMANCE_REPORTED", "PERFORMANCE_MEASURED", "COMMITMENT"]);

const ANSWER_LABEL: Record<string, string> = { audienceProblem: "The viewer's problem", pointOfView: "Her point of view", talkingPoints: "Her talking points", evidence: "Her experience or evidence", story: "A story or visual", nextAction: "What the viewer should do next" };

const fmtDate = (d: Date | null | undefined) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "an earlier date");

/** Did the client say it (not Jordan, not a third party)? */
export function isClientSpoken(f: { speaker: string | null; excerptJson: string | null }, names: string[]): boolean {
  const said = (s: string | null | undefined) => {
    const t = (s ?? "").trim().toLowerCase();
    if (!t) return null;
    if (t === "client") return true;
    if (t === "jordan" || t === "third-party" || t === "staff" || t === "us") return false;
    return names.some((n) => n && (t === n.toLowerCase() || t.startsWith(`${n.toLowerCase()} `) || n.toLowerCase().startsWith(t)));
  };
  const bySpeaker = said(f.speaker);
  if (bySpeaker !== null) return bySpeaker;
  try {
    const ex = JSON.parse(f.excerptJson ?? "[]") as { speaker?: string }[];
    return ex.length > 0 && said(ex[0]?.speaker) === true;
  } catch { return false; }
}

/**
 * A fact that is a DIRECTION for how to make her videos (her tone, what she
 * wants shown or avoided, a content decision), as opposed to something true
 * about her that she can say (Oct 22 2026, the listening fix): "Marcee
 * transitioned into real estate from a role as sales and marketing director"
 * was filed as a brand preference and reached the writer as "never a line to
 * say". The category alone no longer decides; the words do.
 */
const DIRECTION_RE = /\b(?:prefer(?:s|red)?|preference|(?:wants?|would like|likes?|loves?|hates?|(?:does|do)(?:n'?t| not) (?:want|like)) (?:to (?:be (?:seen|known|positioned|perceived)|look|sound|come across|appear|seem|focus|feature|show|highlight|avoid|keep|use|film|post|talk about|mention)|(?:her|his|their|the|more|less|fewer) (?:videos?|content|scripts?|reels?|hooks?|captions?|brand|tone|voice|style|look|edits?))|avoid(?:s|ing)? (?:saying|the word|words?|mentioning|talking about)|tone|brand voice|(?:her|the) voice|style|branding|positioning|on camera|videos?|reels?|scripts?|hooks?|captions?|content|filming|film(?:ed|s)?|editing|music|graphics|b-roll|teleprompter|wardrobe|(?:never|don'?t|do not) say|wording|phrasing)\b/i;
export function isDirectionFact(body: string): boolean {
  return DIRECTION_RE.test(body);
}

/**
 * A month-scoped fact that is still true after its month: about her history,
 * her process, her opinions or her service, not that month's plans (Oct 22
 * 2026, the listening fix). Forty accepted facts migrated from Marcee's notes
 * ("Left senior living ... didn't have total control", "$350 to $500 for a full
 * inspection the seller controls") are filed under old months and never
 * reached the writer.
 */
const MONTH_BOUND_RE = /\b(?:this|next|last|that) (?:month|week|call|session|shoot|quarter)|\b(?:today|tomorrow|yesterday|tonight)\b|\b(?:january|february|march|april|june|july|august|september|october|november|december)\b|\b(?:shoot|filming|film day|schedul\w*|resched\w*|deadline|due by|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
export function isDurableFact(f: { body: string; category: string }): boolean {
  if (TEAM_ONLY_CATEGORIES.has(f.category) || f.category === "DECISION" || f.category === "COMMITMENT") return false;
  if (isInternalTalk(f.body) || isDirectionFact(f.body)) return false;
  return !MONTH_BOUND_RE.test(f.body);
}

type FactRow = { id: string; body: string; category: string; status: string; aiContext: string; confidential: boolean; conflictsWithId: string | null; reviewedBy: string | null; source: string; speaker: string | null; excerptJson: string | null; factDate: Date | null; createdAt: Date; scope?: string | null; monthId?: string | null };

/** The client's facts the writer may use (decision 3), labelled. Pure over the rows given. */
export function writerFactsFrom(rows: FactRow[], o: { names: string[]; keywords: string[]; max?: number; /** The topic's month: a MONTH fact filed under another month must be durable (isDurableFact). */ monthId?: string | null }): PoolFact[] {
  const kept: (WriterFact & { score: number; at: number })[] = [];
  for (const f of rows) {
    if (f.confidential || f.conflictsWithId || CONFIDENTIAL_RE.test(f.body) || CONFIDENTIAL_PHRASE_RE.test(f.body)) continue;
    if (TEAM_ONLY_CATEGORIES.has(f.category)) continue;
    // The fact cleanup's verdicts (factCleanup.ts): TEAM is for us only; a DROP suggestion waits for a person.
    if (f.reviewedBy === TEAM_REVIEWER || (f.reviewedBy ?? "").startsWith(DROP_NOTE_PREFIX)) continue;
    if (isInternalTalk(f.body)) continue;
    if (f.scope === "PROJECT") continue;
    const otherMonth = f.scope === "MONTH" && !!f.monthId && f.monthId !== (o.monthId ?? null);
    let label: string | null = null;
    if (f.status === "ACCEPTED" && f.aiContext === "ALLOWED") label = "accepted";
    else if (!otherMonth && f.status === "PROPOSED" && f.source === "call" && isClientSpoken(f, o.names)) label = `not reviewed yet: she said it on the ${fmtDate(f.factDate ?? f.createdAt)} call`;
    if (!label) continue;
    // An older month's fact: only one about her, never that month's plans.
    if (otherMonth && !isDurableFact(f)) continue;
    if (isDirectionFact(f.body)) label = `${label}; direction for how to write for her, never a line to say`;
    else if (f.category === "BRAND_PREFERENCE" || f.category === "DECISION") label = `${label}; about her, so it can be said`;
    kept.push({ id: f.id, body: f.body.replace(/\s+/g, " ").trim().slice(0, 400), label, score: keywordHits(f.body, o.keywords), at: (f.factDate ?? f.createdAt).getTime() });
  }
  kept.sort((a, b) => b.score - a.score || b.at - a.at);
  return kept.slice(0, o.max ?? FACTS_MAX).map((f, i) => ({ id: `F${i + 1}`, body: f.body, label: f.label, factId: f.id, score: f.score, at: f.at }));
}

/** The facts the brief reads: the pool ranked by these (her) words, then the newest, numbered F1.. Pure. */
export function rankFacts(pool: PoolFact[], keywords: string[], max = FACTS_MAX): (WriterFact & { factId: string })[] {
  return pool
    .map((f) => ({ f, s: keywordHits(f.body, keywords), at: f.at ?? 0 }))
    .sort((a, b) => b.s - a.s || b.at - a.at)
    .slice(0, max)
    .map(({ f }, i) => ({ id: `F${i + 1}`, body: f.body, label: f.label, factId: f.factId }));
}

export type ScriptCandidate = { id: string; title: string; body: string; tier: 3 | 2 | 1; label: string; at: number };

/** Voice examples and same-subject scripts (pure over the candidates). */
export function pickScripts(cands: ScriptCandidate[], keywords: string[], guard: CreativeGuard | null): { related: { title: string; text: string; label: string; id: string }[]; voice: { title: string; text: string; why: string; id: string }[] } {
  const usable = cands.filter((c) => c.body.trim() && !discontinuedHit(`${c.title}\n${c.body}`, guard));
  const scored = usable.map((c) => ({ ...c, hits: keywordHits(`${c.title} ${c.title} ${c.body}`, keywords) }));
  const relatedPool = scored.filter((c) => c.hits >= 2).sort((a, b) => b.hits - a.hits || b.tier - a.tier || b.at - a.at);
  const related = relatedPool.slice(0, 2).map((c) => ({ id: c.id, title: c.title, text: c.body.slice(0, 2000), label: `${c.label}, same subject` }));
  const taken = new Set(related.map((r) => r.id));
  const voicePool = scored.filter((c) => !taken.has(c.id)).sort((a, b) => b.hits - a.hits || b.tier - a.tier || b.at - a.at);
  const voice = voicePool.slice(0, 3).map((c) => ({ id: c.id, title: c.title, text: c.body.slice(0, 1800), why: `${c.label}; ${c.hits >= 2 ? "a related subject" : c.hits === 1 ? "a nearby subject" : "her most recent example, no same-subject script on file"}` }));
  return { related, voice };
}

export async function gatherForTopic(o: GatherOpts): Promise<Gathered> {
  const asOf = o.asOf ?? null;
  const before = asOf ? { lte: asOf } : undefined;
  const t = await prisma.contentTopic.findUnique({ where: { id: o.topicId } });
  if (!t) throw new Error("Topic not found.");
  const gen = await import("@/lib/contentGeneration");
  const built = await gen.buildClientContext(t.enrollmentId, { monthId: o.monthId, excludeScriptId: o.excludeScriptId ?? null });
  const clientId = t.clientId;
  const clientName = built.ctx.clientName;
  const first = clientName.split(/\s+/)[0] ?? clientName;
  const names = [...new Set([clientName, first].filter((n) => n && n.length >= 2))];
  // The guard as it stood at asOf: a series discontinued later was still live then.
  const guard: CreativeGuard | null = built.ctx.creativeGuard ? { ...built.ctx.creativeGuard, discontinued: built.ctx.creativeGuard.discontinued.filter((d) => !asOf || new Date(d.at) <= asOf) } : null;
  const pillarName = t.pillarId ? (await prisma.contentPillar.findUnique({ where: { id: t.pillarId }, select: { name: true } }).catch(() => null))?.name ?? t.pillar ?? "" : t.pillar ?? "";

  // --- why it was chosen ----------------------------------------------------
  const sel = o.monthId ? await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: o.topicId, monthId: o.monthId } }, select: { source: true, createdAt: true, callRecordId: true, evidenceJson: true } }).catch(() => null) : null;
  const how = sel?.source === "client" ? `picked by ${first} in the portal on ${fmtDate(sel.createdAt)}` : sel?.source === "call" ? `chosen on the strategy call of ${fmtDate(sel.createdAt)}` : sel ? `planned by the office on ${fmtDate(sel.createdAt)}` : "in her topic bank";
  const origin = t.source === "ai" ? "the topic was suggested by the AI topic bank from her strategy" : t.source === "strategy_call" ? "the topic came out of a strategy call" : t.source === "client" ? "the topic was her own idea" : t.source === "import" ? "the topic came from her earlier plan" : "the topic was added by the office";
  const whyChosen = [`${how[0].toUpperCase()}${how.slice(1)}`, origin, pillarName ? `it serves the "${pillarName}" pillar` : "", built.ctx.monthPriorities?.length ? `this month she asked for: ${built.ctx.monthPriorities.slice(0, 3).join("; ")}` : ""].filter(Boolean).join("; ") + ".";

  // --- the topic's call(s), in full -----------------------------------------
  const month = o.monthId ? await prisma.contentMonth.findUnique({ where: { id: o.monthId }, select: { id: true, monthKey: true, callRecordId: true, transcriptText: true, strategyCallAt: true } }) : null;
  const callIds = new Set<string>();
  for (const id of [o.callRecordId, sel?.callRecordId, month?.callRecordId]) if (id) callIds.add(id);
  const events = await prisma.contentTopicEvent.findMany({ where: { topicId: o.topicId, sourceRef: { startsWith: "ProgramCallRecord:" } }, select: { sourceRef: true }, take: 10 });
  for (const e of events) callIds.add(e.sourceRef!.slice("ProgramCallRecord:".length));
  if (o.monthId) for (const c of await prisma.programCallRecord.findMany({ where: { monthId: o.monthId, clientId }, select: { id: true }, take: 5 })) callIds.add(c.id);
  const calls = callIds.size ? await prisma.programCallRecord.findMany({ where: { id: { in: [...callIds] }, clientId, ...(asOf ? { OR: [{ scheduledStart: null }, { scheduledStart: before }] } : {}) }, select: { id: true, scheduledStart: true, callType: true } }) : [];
  const transcripts = calls.length ? await prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: calls.map((c) => c.id) }, matchState: "CONFIRMED", text: { not: null }, ...(asOf ? { createdAt: before } : {}) }, orderBy: { version: "desc" }, select: { id: true, callRecordId: true, text: true, supersedesId: true, legacyMonthId: true, recordedAt: true } }) : [];
  const superseded = new Set(transcripts.map((x) => x.supersedesId).filter(Boolean));
  // Oct 22 2026 (the listening fix): the first keywords come from the title and
  // her own words outside the call (the call analysis's quotable lines; her
  // written answers are added below). The AI-written description and intended
  // message only stand in when there is nothing of hers at all. Once the
  // topic's call is read, withHerWords replaces these with her words there.
  const quotable = await gen.quotableLinesForTopic(o.topicId, o.monthId, clientId).catch(() => [] as string[]);
  const herWords: string[] = [...quotable];
  let keywords = topicKeywords(t.title, ...quotable);
  if (keywords.length < 4) keywords = topicKeywords(t.title, t.concept, t.intendedMessage, ...quotable);
  const sources: SourceDoc[] = [];
  const lines = new Map<string, TranscriptLine[]>();
  const callLabels: string[] = [];
  let budget = FULL_CALL_CHARS;
  const seenCall = new Set<string>();
  let cN = 0;
  const addFull = async (label: string, raw: string) => {
    const clean = (await gen.scrubTranscriptForGeneration(clientId, raw)).text;
    const segs = segmentTranscript(clean);
    let text = clean;
    if (text.length > budget) {
      // Longer than the room left: the windows that talk about the topic, not the first N characters.
      text = keywordWindows(segs, keywords, { radius: 8, max: 16, maxChars: Math.max(1500, Math.floor(budget / 16)), minHits: 1 }).map((w) => `${w.time ? `(${w.time}) ` : ""}${w.text}`).join("\n...\n");
    }
    if (!text.trim()) return;
    budget -= text.length;
    const id = `c${++cN}`;
    sources.push({ id, label, kind: "call", text });
    lines.set(id, segmentTranscript(text));
    callLabels.push(label);
  };
  for (const tr of transcripts) {
    if (superseded.has(tr.id) || !tr.callRecordId || seenCall.has(tr.callRecordId) || budget < 2000) continue;
    seenCall.add(tr.callRecordId);
    const call = calls.find((c) => c.id === tr.callRecordId);
    await addFull(`${call?.callType === "BRAND_DISCOVERY" ? "brand discovery call" : "strategy call"} of ${fmtDate(call?.scheduledStart ?? tr.recordedAt)} (this topic's call)`, tr.text!);
  }
  if (!sources.length && month?.transcriptText && (!asOf || !month.strategyCallAt || month.strategyCallAt <= asOf)) {
    await addFull(`strategy call for ${month.monthKey} (this topic's month, pasted transcript)`, month.transcriptText);
  }

  // --- older calls: only the windows that talk about this topic ---------------
  const olderMonths = o.light ? [] : await prisma.contentMonth.findMany({ where: { enrollmentId: t.enrollmentId, transcriptText: { not: null }, ...(o.monthId ? { id: { not: o.monthId } } : {}) }, select: { monthKey: true, transcriptText: true, strategyCallAt: true }, orderBy: { monthKey: "desc" }, take: 12 });
  const otherCalls = o.light ? [] : await prisma.programCallRecord.findMany({ where: { clientId, id: { notIn: [...seenCall] }, transcriptState: { in: ["CONFIRMED", "ANALYZED"] }, ...(asOf ? { scheduledStart: before } : {}) }, select: { id: true, scheduledStart: true }, take: 12 });
  const otherTx = otherCalls.length ? await prisma.programTranscriptSource.findMany({ where: { callRecordId: { in: otherCalls.map((c) => c.id) }, matchState: "CONFIRMED", text: { not: null }, ...(asOf ? { createdAt: before } : {}) }, select: { callRecordId: true, text: true, legacyMonthId: true, recordedAt: true } }) : [];
  const olderDocs: { label: string; text: string }[] = [
    ...olderMonths.filter((m) => !asOf || `${m.monthKey}` <= asOf.toISOString().slice(0, 7)).map((m) => ({ label: `older call for ${m.monthKey}`, text: m.transcriptText! })),
    ...otherTx.map((x) => ({ label: `older call of ${fmtDate(otherCalls.find((c) => c.id === x.callRecordId)?.scheduledStart ?? x.recordedAt)}`, text: x.text! })),
  ];
  // Oct 22 2026 (the listening fix): read and cleaned here, cut into windows by
  // withHerWords once the topic's call has told us her words. Gemini's notes
  // are skipped (transcriptBody): they are a reader's summary, and they matched
  // generic topic words better than her own lines did.
  const older: OlderDoc[] = [];
  // A month's pasted transcript that was also lifted into a transcript source is read once.
  const seenText = new Set<string>();
  for (const d of olderDocs) {
    const sig = d.text.replace(/\s+/g, " ").trim().slice(0, 400);
    if (seenText.has(sig)) continue;
    seenText.add(sig);
    const clean = (await gen.scrubTranscriptForGeneration(clientId, d.text)).text;
    const docLines = segmentTranscript(transcriptBody(clean));
    if (docLines.length) older.push({ label: d.label, lines: docLines });
  }

  // --- what the call analysis already quoted ----------------------------------
  const { safeTopicExcerpts } = await import("@/lib/contentTopics");
  const recorded = o.light ? [] : (await safeTopicExcerpts(o.topicId, o.monthId, clientId).catch(() => ({ kept: [] as { speaker: string; speakerName: string | null; source: string; text: string }[] }))).kept;
  if (recorded.length) {
    const text = recorded.map((e) => `${e.speaker === "client" ? e.speakerName || clientName : e.speaker === "jordan" ? "Jordan" : e.speakerName || "Someone else"}: ${e.text}`).join("\n");
    sources.push({ id: "e1", label: "excerpts the call analysis recorded for this topic", kind: "excerpts", text });
    lines.set("e1", segmentTranscript(text));
  }

  // --- her written answers ----------------------------------------------------
  let answers: { question: string; answer: string }[] = [];
  let interviewId = o.interviewId ?? null;
  if (!interviewId && o.monthId) interviewId = (await prisma.contentInterview.findFirst({ where: { topicId: o.topicId, monthId: o.monthId, clientId, OR: [{ submittedAt: { not: null } }, { sentWithGapsAt: { not: null } }, { status: "SUBMITTED" }] }, orderBy: { updatedAt: "desc" }, select: { id: true } }))?.id ?? null;
  if (interviewId) {
    const a = await (await import("@/lib/contentInterview")).assembleInterviewInputs(interviewId).catch(() => null);
    if (a && a.clientId === clientId) {
      answers = Object.entries(a.input.answers)
        .filter(([, v]) => v && v.text && v.text.trim())
        .map(([k, v]) => ({ question: ANSWER_LABEL[k] ?? k, answer: `${v.text!.trim()}${v.followUpText ? ` (${v.followUpText.trim()})` : ""}`.slice(0, 1500) }));
    }
  }
  for (const a of answers) herWords.push(a.answer);
  if (answers.length) keywords = [...new Set([...keywords, ...topicKeywords(...answers.map((a) => a.answer))])];

  // --- facts (decision 3) -----------------------------------------------------
  const factRows = await prisma.clientFact.findMany({
    where: {
      clientId, confidential: false, conflictsWithId: null,
      OR: [{ status: "ACCEPTED", aiContext: "ALLOWED" }, { status: "PROPOSED", source: "call" }],
      // Oct 22 2026 (the listening fix): an accepted fact filed under an older
      // month is read too; writerFactsFrom keeps it only when it is about her
      // (isDurableFact), never that month's plans.
      AND: [{ OR: [{ scope: "PERMANENT" }, ...(o.monthId ? [{ scope: "MONTH", monthId: o.monthId }] : []), { scope: "MONTH", status: "ACCEPTED", aiContext: "ALLOWED" }] }],
      ...(asOf ? { createdAt: before } : {}),
    },
    orderBy: [{ factDate: "desc" }, { createdAt: "desc" }],
    take: 300,
    select: { id: true, body: true, category: true, status: true, aiContext: true, confidential: true, conflictsWithId: true, reviewedBy: true, source: true, speaker: true, excerptJson: true, factDate: true, createdAt: true, scope: true, monthId: true },
  });
  const secret = await confidentialFilter(clientId);
  const scrubOne = async (text: string) => (await gen.scrubOtherClients(clientId, [text])).stripped === 0;
  const factCands = writerFactsFrom(factRows, { names, keywords, max: FACT_POOL_MAX + 10, monthId: o.monthId });
  const factPool: PoolFact[] = [];
  for (const f of factCands) {
    if (factPool.length >= FACT_POOL_MAX) break;
    if (secret(f.body) || !(await scrubOne(f.body))) continue;
    factPool.push(f);
  }
  const facts = rankFacts(factPool, keywords);

  // --- scripts: same subject, and voice ---------------------------------------
  const scripts = await prisma.contentScript.findMany({
    // Never this topic's own script (an earlier version of the same video is not "her earlier script on the subject").
    // The OR keeps scripts with no topic: a NOT on a nullable column alone would drop them.
    where: {
      enrollmentId: t.enrollmentId, ...(o.excludeScriptId ? { id: { not: o.excludeScriptId } } : {}),
      AND: [{ OR: [{ topicId: null }, { topicId: { not: o.topicId } }] }, { OR: [{ clientApprovedVersionId: { not: null } }, { approvedVersionId: { not: null } }, { historical: true }, { source: "import" }] }],
    },
    select: { id: true, title: true, body: true, historical: true, source: true, approvedVersionId: true, approvedAt: true, clientApprovedVersionId: true, clientApprovedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 120,
  });
  const vIds = [...new Set(scripts.flatMap((s) => [s.clientApprovedVersionId, s.approvedVersionId]).filter((x): x is string => !!x))];
  const vBodies = new Map((vIds.length ? await prisma.contentScriptVersion.findMany({ where: { id: { in: vIds } }, select: { id: true, body: true } }) : []).map((v) => [v.id, v.body]));
  const cands: ScriptCandidate[] = [];
  for (const s of scripts) {
    let c: ScriptCandidate | null = null;
    if (s.clientApprovedVersionId && s.clientApprovedAt && (!asOf || s.clientApprovedAt <= asOf)) c = { id: s.id, title: s.title, body: vBodies.get(s.clientApprovedVersionId) ?? "", tier: 3, label: "approved by her", at: s.clientApprovedAt.getTime() };
    else if (s.approvedVersionId && (!asOf || (s.approvedAt ?? s.createdAt) <= asOf)) c = { id: s.id, title: s.title, body: vBodies.get(s.approvedVersionId) ?? "", tier: 2, label: "approved by the office", at: (s.approvedAt ?? s.createdAt).getTime() };
    else if ((s.historical || s.source === "import") && (!asOf || s.createdAt <= asOf)) c = { id: s.id, title: s.title, body: s.body, tier: 1, label: "a script from her filmed archive", at: s.createdAt.getTime() };
    if (!c || !c.body.trim() || CONFIDENTIAL_RE.test(c.body) || !(await scrubOne(c.body))) continue;
    cands.push(c);
  }
  const picked = pickScripts(cands, keywords, guard);

  // --- the context -------------------------------------------------------------
  // asOf (phase 3): the strategy version that was approved at that moment, not a later one.
  let doc = built.ctx.strategy?.document ?? null;
  let strategyVersionId = built.strategyVersionId;
  if (asOf) {
    const then = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId: t.enrollmentId, approvedAt: { lte: asOf }, status: { in: ["APPROVED", "SUPERSEDED"] } }, orderBy: { approvedAt: "desc" }, select: { id: true, sectionsJson: true } });
    if (then && then.id !== strategyVersionId) {
      const { parseStoredSections } = await import("@/lib/contentStrategy");
      const { withCanonicalFramework, isFrameworkSection } = await import("@/lib/contentPolicy");
      const stored = parseStoredSections(then.sectionsJson);
      const fw = stored?.sections.find((x) => isFrameworkSection(x));
      doc = stored?.document ? withCanonicalFramework(stored.document, fw?.text ?? null) : null;
      strategyVersionId = then.id;
    } else if (!then) { doc = null; strategyVersionId = null; }
  }
  let strategyText = doc ? renderStrategy(doc, { preserveSourceHeadings: true }) : null;
  if (strategyText && strategyText.length > 14_000) strategyText = `${strategyText.slice(0, 14_000)} ...`;
  const ctx: WriterContext = {
    clientName,
    speakerNames: names,
    strategyText,
    identityBlock: creativeIdentityBlock(built.ctx.creativeIdentity),
    // v2.6: her boundaries on their own, for the writer's short prompt (the identity block is the brief's).
    boundaries: (built.ctx.creativeIdentity?.boundaries ?? []).map((b) => b.text).filter(Boolean).slice(0, 8),
    guardBlock: creativeGuardBlock(guard),
    monthPriorities: built.ctx.monthPriorities ?? [],
    topic: { title: t.title, pillar: pillarName, description: t.concept, intendedMessage: t.intendedMessage, audienceNeed: t.audienceNeed, businessGoal: t.businessGoal, whyChosen },
    facts: facts.map(({ id, body, label }) => ({ id, body, label })),
    voiceRefs: picked.voice.map(({ title, text, why }) => ({ title, text, why })),
    relatedScripts: picked.related.map(({ title, text, label }) => ({ title, text, label })),
    answers,
    captionExamples: doc?.captionCtaExamples?.items ?? [],
  };
  const holdBack = async (text: string) => secret(text) || !(await scrubOne(text));
  return assemble({
    ctx, enrollmentId: t.enrollmentId, clientId, pillarId: t.pillarId, strategyVersionId, policyVersionId: built.policyVersionId,
    sources, lines, keywords, holdBack, callLabels, answers: answers.length, picked, facts,
    inputRefs: { writer: true, strategyVersionId, callRecordIds: [...seenCall], recordedExcerpts: recorded.length, interviewId, asOf: asOf?.toISOString() ?? null },
    videoStyle: built.ctx.videoStyle === "SKITS" ? "SKITS" : "DIRECT",
    olderDocs: older, factPool, scriptCands: cands, guard, herWords: [t.title, ...herWords],
  });
}

type Picked = ReturnType<typeof pickScripts>;

/** The Gathered shape from its parts: the texts and labels that follow from the sources, facts and scripts chosen. Pure. */
function assemble(a: Omit<Gathered, "clientText" | "callText" | "labels"> & { callLabels: string[]; answers: number; picked: Picked; facts: (WriterFact & { factId: string })[] }): Gathered {
  const { callLabels, answers, picked, facts, ...g } = a;
  const ctx: WriterContext = {
    ...g.ctx,
    facts: facts.map(({ id, body, label }) => ({ id, body, label })),
    voiceRefs: picked.voice.map(({ title, text, why }) => ({ title, text, why })),
    relatedScripts: picked.related.map(({ title, text, label }) => ({ title, text, label })),
  };
  const olderWindows = g.sources.filter((s) => s.kind === "older").length;
  const clientText = [
    ...g.sources.map((s) => s.text),
    ...ctx.answers.map((x) => x.answer),
    ...facts.map((f) => f.body),
    ...picked.related.map((r) => r.text),
    ctx.strategyText ?? "",
  ].join("\n");
  const callText = g.sources.filter((s) => s.kind === "call").map((s) => `[${s.id}] ${s.label}\n${s.text}`).join("\n\n");
  return {
    ...g, ctx, clientText, callText,
    labels: { calls: callLabels, olderWindows, relatedScripts: picked.related.map((r) => `${r.title} (${r.label})`), voiceRefs: picked.voice.map((v) => ({ title: v.title, why: v.why })), answers },
    inputRefs: {
      ...g.inputRefs, olderWindows,
      factIds: facts.map((f) => f.factId), unreviewedFacts: facts.filter((f) => f.label.startsWith("not reviewed")).length,
      relatedScriptIds: picked.related.map((r) => r.id), voiceScriptIds: picked.voice.map((v) => v.id),
    },
  };
}

/** The best windows of her older calls for these words, across every older call, best first (OLDER_WINDOWS_MAX at most). Pure. */
export function olderWindowsFor(docs: OlderDoc[], keywords: string[], max = OLDER_WINDOWS_MAX): { label: string; text: string; time: string | null; score: number }[] {
  const out: { label: string; text: string; time: string | null; score: number }[] = [];
  for (const d of docs) for (const w of keywordWindows(d.lines, keywords, { radius: 5, max: 3, maxChars: 2200 })) out.push({ label: d.label, text: w.text, time: w.time, score: w.score });
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/**
 * AFTER THE TOPIC'S CALL IS READ (Oct 22 2026, the listening fix): her words
 * there (the passages retrieval found, with the lines around them, which
 * carry the interviewer's question), the title and her other words become the
 * keywords, and by them: her older calls' windows (added as sources o1..o8 for
 * the second retrieval), the facts the brief reads (ranked, numbered F1..), and
 * her same-subject scripts. Pure over the Gathered it is given.
 */
export function withHerWords(g: Gathered, passages: { quote: string; context?: string | null }[]): Gathered {
  const mine = herKeywords({ title: g.ctx.topic.title, passages, herWords: g.herWords });
  const keywords = mine.length >= 3 ? mine : [...new Set([...mine, ...g.keywords])];
  const sources = g.sources.filter((s) => s.kind !== "older");
  const lines = new Map([...g.lines].filter(([id]) => !id.startsWith("o")));
  olderWindowsFor(g.olderDocs, keywords).forEach((w, i) => {
    const id = `o${i + 1}`;
    sources.push({ id, label: `${w.label}${w.time ? `, around ${w.time}` : ""} (her earlier call: a passage with her words on this subject)`, kind: "older", text: w.text });
    lines.set(id, segmentTranscript(w.text));
  });
  const { clientText: _c, callText: _t, labels, ...rest } = g;
  void _c; void _t;
  return assemble({
    ...rest, sources, lines, keywords,
    callLabels: labels.calls, answers: labels.answers,
    picked: pickScripts(g.scriptCands, keywords, g.guard),
    facts: rankFacts(g.factPool, keywords),
  });
}
