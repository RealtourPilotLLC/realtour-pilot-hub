// ---------------------------------------------------------------------------
// THE SCRIPT WRITER'S PROMPTS (Oct 22 2026; v2.6 Oct 23 2026). Pure: strings
// and JSON schemas, no provider call. Four steps, each its own system prompt
// (stable, so the API caches it) and its own structured-output schema:
//
//   1. retrieval  read the topic's call(s) in full and older call windows;
//                 quote, verbatim, every passage where the client talks about
//                 this topic; mark what a buyer or seller should hear and what
//                 is internal talk                                (medium)
//   2. brief      the topic brief: one angle, one proof, the viewer, what she
//                 said, must-keep / optional / excluded, contradictions, the
//                 close type; facts, opinions, ideas and OUR assumptions apart
//                                                                 (medium)
//   3. writer     v2.6: ONE call writes the whole script (HOOK, RE-HOOK,
//                 BUILD-UP, PAYOFF, CLOSE) from the brief and her own words,
//                 with a short prompt and, as the bar, up to three scripts
//                 Jordan approved and sent to other clients; the same
//                 system prompt writes the one whole rewrite and a person's or
//                 a client's revision                             (high)
//   4. review     v2.6: reads the script as a viewer FIRST (one thought, she
//                 would say it, the hook lands and the rest follows, nothing
//                 invented), a 1 to 10 read, and one note for the rewrite
//                                                                 (medium)
// (v2.2 to v2.5 had a fifth step, five scored hooks before the draft, and a
// review of twelve checks and a craft block; both are gone.)
// The models and efforts per step: scriptWriter/pipeline STEP_MODEL and
// STEP_EFFORT. v2.3: each user message is built in segments (StepPrompt
// blocks): the long stable material first, ending in a cache breakpoint, the
// per-round material after.
//
// Structured outputs: every object has additionalProperties false and lists
// every property as required; counts are checked by code, not the schema.
// No dash is used as punctuation in any prompt text: the model mirrors it.
// ---------------------------------------------------------------------------

import { CLOSE_RULE, HOMEOWNER_LANGUAGE_RULE, TOPIC_LABEL_RULE, ASSUMPTION_RULE, BACKGROUND_RULE, WORDING_RULE, HOUSE_CRAFT_RULES, WRITER_LENGTH, WRITER_VERSION, BRIEF_MUST_KEEP_MAX, estimateSeconds } from "./rules";
import type { TopicBrief, WriterFact, WriterPassage } from "./record";

export type JsonSchema = Record<string, unknown>;
/**
 * `blocks` (v2.3, prompt caching): the same prompt in segments. A segment with
 * `cache` ends in a cache breakpoint: the long, stable material (her call, her
 * sources, the brief) goes first, the per-round material (the version under
 * review, the instruction) after, so the next round of the same step reads the
 * front from the cache. `prompt` is the blocks' texts joined, for the reuse
 * hash and the run ledger.
 */
export type StepPrompt = { system: string; prompt: string; schema: JsonSchema; blocks?: { text: string; cache?: boolean }[] };

/** A step prompt from stable segments (each cached) and the per-round tail. Empty parts are dropped. Pure. */
function segmented(system: string, schema: JsonSchema, stable: string[][], tail: string[]): StepPrompt {
  const join = (xs: string[]) => xs.filter((x) => x && x.trim()).join("\n\n");
  const segs = stable.map(join).filter(Boolean);
  const rest = join(tail);
  const blocks = [...segs.map((text) => ({ text, cache: true })), ...(rest ? [{ text: rest }] : [])];
  return { system, prompt: blocks.map((b) => b.text).join("\n\n"), schema, blocks };
}

const obj = (properties: Record<string, JsonSchema>, description?: string): JsonSchema => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...(description ? { description } : {}) });
const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const arr = (items: JsonSchema, description?: string): JsonSchema => ({ type: "array", items, ...(description ? { description } : {}) });
const ITEM = obj({ text: str(), source: str("Where it comes from: a passage id (P3), a fact id (F2), \"written answers\", \"strategy\", or \"our assumption\".") });

/** Everything about the client and the topic the steps share. Built by sources.ts; nothing here belongs to another client. */
export type WriterContext = {
  clientName: string;
  /** How the client appears as a speaker in transcripts (her full name, first name). */
  speakerNames: string[];
  strategyText: string | null;
  identityBlock: string;
  guardBlock: string;
  monthPriorities: string[];
  topic: { title: string; pillar: string; description: string | null; intendedMessage: string | null; audienceNeed: string | null; businessGoal: string | null; whyChosen: string };
  facts: WriterFact[];
  voiceRefs: { title: string; text: string; why: string }[];
  relatedScripts: { title: string; text: string; label: string }[];
  answers: { question: string; answer: string }[];
  captionExamples: string[];
  /** v2.6: her creative identity's boundaries (never cross these), shown to the writer. */
  boundaries?: string[];
  /** v2.6: the bar: up to three scripts Jordan approved and sent to OTHER clients (scriptWriter/barExamples), five parts each. */
  barExamples?: { hook: string; rehook: string; buildup: string; payoff: string; close: string }[];
};

export type SourceDoc = { id: string; label: string; kind: "call" | "older" | "excerpts"; text: string };

function topicBlock(ctx: WriterContext): string {
  const t = ctx.topic;
  const ours = [
    t.description ? `- description: ${t.description}` : "",
    t.intendedMessage ? `- intended message: ${t.intendedMessage}` : "",
    t.audienceNeed ? `- audience need: ${t.audienceNeed}` : "",
    t.businessGoal ? `- business goal: ${t.businessGoal}` : "",
  ].filter(Boolean);
  return [
    `TOPIC (an organizing label, not spoken copy): ${t.title}`,
    `PILLAR: ${t.pillar || "(none linked)"}`,
    `WHY IT WAS CHOSEN: ${t.whyChosen}`,
    ...(ours.length ? ["OUR ASSUMPTIONS ABOUT THIS TOPIC (written by us or an AI; never a claim source, never her words):", ...ours] : []),
  ].join("\n");
}

function factsBlock(facts: WriterFact[]): string {
  if (!facts.length) return "CLIENT FACTS: none on file that a buyer or seller should hear.";
  return ["CLIENT FACTS (each with its status; a fact \"not reviewed yet\" is what the client said on a call, usable now, still waiting for the office's review):", ...facts.map((f) => `[${f.id}] ${f.body} (${f.label})`)].join("\n");
}

function clientBlock(ctx: WriterContext, opts: { strategy?: boolean } = {}): string {
  const lines = [`CLIENT: ${ctx.clientName}`];
  if (ctx.monthPriorities.length) lines.push("", "THIS MONTH'S PRIORITIES (from the client):", ...ctx.monthPriorities.map((p) => `- ${p}`));
  if (opts.strategy !== false) lines.push("", ctx.strategyText ? `APPROVED STRATEGY (approved by the office; her positioning, audience and pillars):\n${ctx.strategyText}` : "APPROVED STRATEGY: none on file.");
  if (ctx.identityBlock) lines.push("", ctx.identityBlock);
  if (ctx.guardBlock) lines.push("", ctx.guardBlock);
  return lines.join("\n");
}

function passagesBlock(passages: WriterPassage[]): string {
  if (!passages.length) return "WHAT SHE SAID ABOUT THIS TOPIC: nothing on record. The script can carry no experience of hers that the facts or answers below do not give.";
  return [
    "WHAT SHE SAID ABOUT THIS TOPIC (verbatim passages from her calls, each with the lines around it; a speaker label shows who is talking):",
    ...passages.map((p) => `[${p.id}] ${p.source}${p.time ? ` at ${p.time}` : ""} · ${p.kind}${p.why ? ` · ${p.why}` : ""}\nQUOTE: "${p.quote}"\nAROUND IT:\n${p.context}`),
  ].join("\n\n");
}

function answersBlock(ctx: WriterContext): string {
  if (!ctx.answers.length) return "";
  return ["HER WRITTEN ANSWERS ABOUT THIS TOPIC (her own words):", ...ctx.answers.map((a) => `- ${a.question}: ${a.answer}`)].join("\n");
}

function scriptsBlock(ctx: WriterContext): string {
  const out: string[] = [];
  if (ctx.relatedScripts.length) {
    out.push("HER EARLIER SCRIPTS ON THE SAME SUBJECT (what she has already said on camera; evidence of her views and process, never lines to reuse):");
    for (const s of ctx.relatedScripts) out.push(`--- ${s.title} (${s.label}) ---`, s.text);
  }
  if (ctx.voiceRefs.length) {
    out.push("", "VOICE EXAMPLES (how she sounds; each says why it is here; never reuse their lines, their length or their structure):");
    for (const s of ctx.voiceRefs) out.push(`--- ${s.title} (${s.why}) ---`, s.text);
  }
  return out.join("\n");
}

const TARGET_LINE = `TARGET LENGTH: about ${WRITER_LENGTH.target} spoken words (about ${estimateSeconds(WRITER_LENGTH.target)} seconds), inside ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]}; ${WRITER_LENGTH.cap} is the hard cap.`;

// ---------------------------------------------------------------------------
// 1. Retrieval
// ---------------------------------------------------------------------------

export const RETRIEVAL_SYSTEM = `You read call transcripts for ONE video topic of a Realtour Pilot client (a real estate professional), and you return, verbatim, every passage where the CLIENT talks about that topic.

WHAT TO RETURN
- Every passage where the client discusses this topic or the experience, process, opinion, story, reason or example behind it: not only the line where she agreed to film it. Read the whole call; the useful part is often minutes away from where the topic was named. Her reasons (why she changed careers, why she works the way she does) and the insight that ties her story to the viewer are the most important passages of all.
- Return WHOLE THOUGHTS: a quote runs to where she finishes the point, past a listener's "Mhm" or "Right", including the sentence that lands it. Stopping one sentence early loses the line that matters.
- Each quote is the transcript's own words, copied exactly and contiguously (60 to 600 characters; return two passages for a longer answer). Never paraphrase, never join two places into one quote, never fix her grammar. A quote that is not in the transcript is thrown away.
- A reader's notes or summary at the top of a call are not her words: use them to find where she said something, then quote her.
- Name the source id the quote comes from and who is speaking (client, us = Realtour Pilot staff such as Jordan, other = anyone else).
- Lines spoken by Realtour Pilot staff are prompts and suggestions, never her experience; return one only when it is needed to understand her answer, marked speaker "us".
- THE INTERVIEWER'S QUESTION: also return the line (or two) where Realtour Pilot staff (usually Jordan) introduced this topic or asked her about it on the topic's call, and anything he said about what her answer should become, as speaker "us", kind "question". It tells the writer what the video is meant to answer. When he asked for an example (have you ever, a real example, what was the outcome), return that question, and return her answer to it in full: it is usually the story the video is built on.
- A FORMAT AGREED ON THE CALL for this video (word association, two voices, a trend alert) is a creative decision the script follows, never internal talk or production talk: return it, forViewer true (kind "creative_idea" when she said it, kind "question" when he did).
- OLDER CALLS: a source labelled as her earlier call is the same client on an earlier date. Quote a passage from it when it adds a reason, an example, a detail of her process or a strong phrase of hers on THIS topic's subject; skip what is about another subject.

DISCERNMENT (forViewer)
- forViewer true: something a buyer or a seller would benefit from hearing: her experience, her process, her opinions, her stories, client situations she describes without private details, how she protects or advises people.
- forViewer false, with the reason: internal talk (scheduling, filming logistics, editing, our pricing, billing or contract, the content plan itself), private personal details, other clients by name, complaints about Realtour Pilot, anything said in confidence.
- Keep the passage either way; the reason is how the writer knows what to leave out.

The topic title and our assumptions about it are search aids, not facts. Return passages in transcript order.`;

export const RETRIEVAL_SCHEMA: JsonSchema = obj({
  passages: arr(obj({
    sourceId: str("The id in brackets before the source text, e.g. c1 or o2."),
    speaker: { type: "string", enum: ["client", "us", "other"] },
    kind: { type: "string", enum: ["experience", "process", "opinion", "story", "client_example", "creative_idea", "fact", "agreement", "question"] },
    quote: str("Verbatim from the source, contiguous, 60 to 600 characters."),
    forViewer: { type: "boolean" },
    reason: str("When forViewer is false: why a viewer should not hear it. Otherwise an empty string."),
    why: str("One short line: what this passage gives the script."),
  })),
  overview: str("Two or three sentences: what she actually said about this topic overall."),
});

/**
 * The retrieval step. Oct 22 2026 (the listening fix): it runs twice: first on
 * the topic's call(s) and the recorded excerpts, then (when her words there
 * found any) on her older calls' windows, told what she already said so it
 * returns what ADDS to it. v2.3 (prompt caching): the sources come first, in
 * front of a cache breakpoint (a month's topics from one call share them),
 * and the topic to look for after them.
 */
export function buildRetrievalPrompt(ctx: WriterContext, sources: SourceDoc[], opts: { already?: { quote: string; source: string }[] } = {}): StepPrompt {
  const older = sources.length > 0 && sources.every((s) => s.kind === "older");
  return segmented(RETRIEVAL_SYSTEM, RETRIEVAL_SCHEMA, [[
    `CLIENT: ${ctx.clientName}. In transcripts she appears as: ${ctx.speakerNames.join(", ") || "(her name)"}.`,
    ...sources.map((s) => `[${s.id}] ${s.label}\n${s.text}`),
  ]], [
    older ? "THE SOURCES ABOVE ARE HER EARLIER CALLS (the same client, on other dates), each cut to the windows where her words on this subject appear. Return what she says there on THIS topic's subject that adds a reason, an example, a detail of her process or a strong phrase of hers." : "",
    older && opts.already?.length ? ["WHAT SHE ALREADY SAID ON THIS TOPIC'S CALL (found already; do not return these again):", ...opts.already.slice(0, 14).map((a) => `- "${a.quote.slice(0, 240)}" (${a.source})`)].join("\n") : "",
    "THE TOPIC TO FIND IN THE SOURCES ABOVE:",
    topicBlock(ctx),
  ]);
}

// ---------------------------------------------------------------------------
// 2. Topic brief
// ---------------------------------------------------------------------------

export const BRIEF_SYSTEM = `You write the TOPIC BRIEF for ONE monthly personal-brand video of a Realtour Pilot client (a real estate professional), before anyone writes the script. Realtour Pilot leads the creative direction; the client supplies the expertise, the experiences and the voice. The brief is how the writer and the reviewer know what this video must say, and what it must not.

Decide:
- videoType: "story" for a personal brand story (her background, a career change, why she does this work), "educational" for everything that teaches the viewer something.
- whatWeAsked: the interviewer's question for this topic on the call (Realtour Pilot staff, usually Jordan; see WHAT WE ASKED and THE FULL CALL), short and close to his words, with its time, plus anything he said about what her answer should become. It defines the topic's INTENT: the video answers that question. When he asked for an example (have you ever, a real example, what was the outcome), keep that question in whatWeAsked, word for word. An empty string when there is none.
- angle: ONE sentence: the belief or tension the video opens on and the one thing the viewer leaves with. Her answer usually holds several good reasons and examples; the video is stronger with one. CHOOSE.
- proof: the ONE proof of the angle, with its source. Prove it with one real moment she told: what happened, one number or detail, how it ended. When the interviewer asked for an example, her answer is the proof and a must-keep. A restated opinion or a reason is never the proof; only when she told no story on this topic is the proof one specific detail of her process (never an invented story). A story that seems to contradict the message is framed, not dropped. For a personal story the proof is the turn. isHerStory: true when the proof is a moment she told. A second story or reason goes in optional.
- centralMessage: the INSIGHT plus HOW SHE HELPS: what the viewer should understand about their own situation, and why she is the person to help with it. Not a fun fact about her (who her favorite clients are, a hobby, an award). Understand what the topic is really about; the title's wording is not the message.
- viewer: the one person this is for, in plain words (a homeowner thinking of selling, a first-time buyer), never a demographic. It comes from what SHE said about who she helps here, never an inference of ours; when her story serves two groups, the viewer is both.
- whyChosen: why this topic was picked, from what you are told (her call, her portal pick, the month's priorities, the pillar).
- pillar: the linked content pillar.
- whatSheSaid: the passage ids (P1, P2 ...) that carry her actual words on this, most important first.
- mustKeep: the POINTS the script cannot lose and still be true and complete, each written as a short point in plain words (its meaning, NOT a quote of her sentence), with its source (a passage id, or "call at 01:09:23"). For a personal story these are the story's beats in order (where she was and what she loved, her real reason for the change, what she expected, the turn, what the viewer needs that she gives, how she helps now), at most ${BRIEF_MUST_KEEP_MAX.story}. For an educational video at most ${BRIEF_MUST_KEEP_MAX.educational}, most important first: the belief, the proof (her real moment, when she told one), and how she helps (how she helps appears once, in the payoff or the close, never both). The invitation and what the viewer should do next are never must-keep: they belong to the close. With the hook and the close they have to fit in about ${WRITER_LENGTH.target} spoken words; everything else good goes in optional. inProgress is true for a point about a deal still in progress.
- NEVER A LIVE DEAL: an offer she just wrote, a listing she is negotiating now, a client's sale still in progress, or anything that identifies a specific listing or a person, is never must-keep and never the proof. Put it in excluded: never in the script. Keep it out of verifiedFacts, opinions, optional and herPhrases too.
- A story she has already told on camera is never this video's proof. Her earlier scripts are listed below: when her moment is one of them, choose another moment she told, or let the insight be the proof.
- herPhrases: up to five SHORT phrases of hers (a few words each) that are strong and natural on camera and worth saying exactly (her own vocabulary, a few words that carry feeling or a picture). Never a rambling spoken sentence, and never an industry term a homeowner would not say: her phrases never override plain words.
- optional: good material that can go if length needs it.
- excluded: what stays out and why (internal talk, background reasoning she did not present as her message, a second topic, job duties and side facts that would make it a biography, anything private). Her actual reason for a career change is never excluded as "biography": it is the heart of that story. A format agreed on the call for this video is never internal talk and never excluded.
- contradictions: places where her sources disagree with each other or with our assumptions. Flag them; never resolve one by inventing an answer.
- WHEN THE PROOF AND THE MESSAGE DISAGREE: when a contradiction you list says her proof does not support the message (her story shows one thing; the topic's wording, or a rule she repeats, says another), the angle takes the message the proof supports, and centralMessage and mustKeep follow it. The other message is left out, or kept only where it does not argue with her story. Never frame a story around a message it contradicts.
- verifiedFacts / opinions / creativeIdeas / ourAssumptions: kept apart. A verified fact is something she stated as true about herself, her work or her process (a passage, the call, a fact, her answers). An opinion is her view. A creative idea is a hook, line or angle she suggested, or a format agreed on the call for this video (word association, two voices, a trend alert, whoever proposed it), written as "Agreed format: ..."; an agreed format is a creative decision the script follows. Our assumptions are the topic's description, intended message, audience need and business goal, and anything you infer: never a claim source.
- closeType: "cta" by default (a warm spoken invitation tied to the message), "callback" only for a story with no service angle; closeWhy in one line.

CHECK AGAINST THE WHOLE CALL: the passages are the material, but THE FULL CALL is given below too. Before you mark anything unverified, excluded or contradictory, look for it in the full call: if she says it anywhere (often right after a passage ends), it is hers; cite the time. A passage from one of her EARLIER calls is her own words too (the same client): it counts as material and as a source for a claim, cited by its date. A reader's notes or summary at the top of a call are a pointer, never her words.

${WORDING_RULE}
${HOUSE_CRAFT_RULES}
${HOMEOWNER_LANGUAGE_RULE}
${TOPIC_LABEL_RULE}
${ASSUMPTION_RULE}
${BACKGROUND_RULE}
${CLOSE_RULE}
${TARGET_LINE}`;

export const BRIEF_SCHEMA: JsonSchema = obj({
  videoType: { type: "string", enum: ["story", "educational"] },
  whatWeAsked: str("The interviewer's question for this topic, with its time, or an empty string."),
  angle: str("One sentence: the belief or tension it opens on and the one thing the viewer leaves with."),
  proof: obj({ text: str(), source: str(), isHerStory: { type: "boolean", description: "True when the proof is a real moment she told (what happened, a detail, how it ended)." } }, "The one proof of the angle, with its source: one real moment she told, when she told one."),
  centralMessage: str(),
  viewer: str(),
  whyChosen: str(),
  pillar: str(),
  whatSheSaid: arr(str("A passage id, e.g. P2.")),
  mustKeep: arr(obj({ text: str("The point in plain words: its meaning, not a quote of her sentence."), source: str("A passage id (P3), \"call at 01:09:23\", a fact id (F2), \"written answers\" or \"strategy\"."), inProgress: { type: "boolean", description: "True when the point is about a deal or a sale still in progress." } })),
  herPhrases: arr(obj({ text: str("A short phrase of hers, a few words, strong and natural on camera."), source: str() })),
  optional: arr(ITEM),
  excluded: arr(obj({ text: str(), reason: str() })),
  contradictions: arr(obj({ text: str(), sources: str() })),
  verifiedFacts: arr(ITEM),
  opinions: arr(ITEM),
  creativeIdeas: arr(ITEM),
  ourAssumptions: arr(ITEM),
  closeType: { type: "string", enum: ["cta", "callback"] },
  closeWhy: str(),
});

/** The topic's own call in full, for checking what she said (Oct 22 2026, v2.1). Internal talk in it is still never script material. */
export function fullCallBlock(callText: string | null | undefined): string {
  if (!callText?.trim()) return "";
  return `THE FULL CALL (to check what she said, anywhere in it; the passages are the material; the notes at the top are a reader's summary, not her words; internal talk about our work with her is never script material):\n${callText}`;
}

/** v2.3 (prompt caching): the client and the full call first, in front of a cache breakpoint (a month's topics from one call share them); this topic's material after. */
export function buildBriefPrompt(ctx: WriterContext, passages: WriterPassage[], excluded: { quote: string; source: string; reason: string }[], overview: string | null, callText: string | null = null, asked: { quote: string; source: string; time: string | null }[] = []): StepPrompt {
  return segmented(BRIEF_SYSTEM, BRIEF_SCHEMA, [[clientBlock(ctx), fullCallBlock(callText)]], [
    topicBlock(ctx),
    asked.length ? ["WHAT WE ASKED (the interviewer's lines on this topic, found on the call; never her words, never script material; they say what the video is meant to answer):", ...asked.map((a) => `- "${a.quote}" (${a.source}${a.time ? ` at ${a.time}` : ""})`)].join("\n") : "",
    overview ? `WHAT SHE SAID OVERALL (a reader's summary of the calls, for orientation only): ${overview}` : "",
    passagesBlock(passages),
    excluded.length ? ["PASSAGES HELD BACK (not for a viewer; the reason is why):", ...excluded.slice(0, 12).map((e) => `- ${e.source}: "${e.quote.slice(0, 200)}" (${e.reason})`)].join("\n") : "",
    answersBlock(ctx),
    factsBlock(ctx.facts),
    scriptsBlock({ ...ctx, voiceRefs: [] }),
  ]);
}

/** The brief as every later step reads it. */
export function briefText(b: TopicBrief): string {
  const items = (label: string, xs: { text: string; source: string }[]) => (xs.length ? [`${label}:`, ...xs.map((x) => `- ${x.text} [${x.source}]`)] : []);
  return [
    "TOPIC BRIEF",
    ...(b.videoType ? [`Video: ${b.videoType === "story" ? "a personal story (her moment, in the order it happened)" : "educational (one belief, one proof, how she helps)"}`] : []),
    ...(b.whatWeAsked ? [`What we asked her (the topic's intent; the video answers it): ${b.whatWeAsked}`] : []),
    ...(b.angle ? [`Angle (the one thing): ${b.angle}`] : []),
    ...(b.proof?.text ? [`The one proof${b.proof.isHerStory ? " (a moment she told: keep what happened, the detail and how it ended)" : ""}: ${b.proof.text} [${b.proof.source}]`] : []),
    `Central message: ${b.centralMessage}`,
    `Viewer: ${b.viewer}`,
    `Why chosen: ${b.whyChosen}`,
    `Pillar: ${b.pillar}`,
    `Close: ${b.closeType === "cta" ? "a warm spoken invitation tied to the message (the default)" : "a callback to the hook (a story with no service angle; a soft invitation is still welcome)"}. ${b.closeWhy}`,
    `Target: about ${b.target.words ?? WRITER_LENGTH.target} spoken words, inside ${b.target.aim[0]} to ${b.target.aim[1]} (about ${b.target.seconds[0]} to ${b.target.seconds[1]} seconds); ${b.target.cap} is the cap. Only the must-keep points must survive.`,
    ...(b.whatSheSaid.length ? ["What she said (verbatim, the MATERIAL; the wording on camera is ours):", ...b.whatSheSaid.map((p) => `- [${p.passageId}] "${p.quote}" (${p.source}${p.time ? ` at ${p.time}` : ""})`)] : []),
    ...items("Must keep (points, in meaning)", b.mustKeep),
    ...items("Her phrases worth saying exactly", b.herPhrases ?? []),
    ...items("Optional", b.optional),
    ...(b.excluded.length ? ["Excluded:", ...b.excluded.map((x) => `- ${x.text} (${x.reason})`)] : []),
    ...(b.contradictions.length ? ["Contradictions (flagged, not resolved):", ...b.contradictions.map((x) => `- ${x.text} [${x.sources}]`)] : []),
    ...items("Verified facts", b.verifiedFacts),
    ...items("Her opinions", b.opinions),
    ...items("Her creative ideas (an agreed format is a creative decision the script follows)", b.creativeIdeas),
    ...items("Our assumptions (never a claim source)", b.ourAssumptions),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. The writer (v2.6): ONE call writes the whole script; the same system
//    prompt writes the one whole rewrite and a person's or a client's revision
// ---------------------------------------------------------------------------

/** A script in the five labelled parts, as the examples, the rewrite and the review show it. Pure. */
export function partsBlock(p: { hook: string; rehook: string; buildup: string; payoff: string; close: string }): string {
  return [`HOOK: ${p.hook}`, `RE-HOOK: ${p.rehook}`, `BUILD-UP: ${p.buildup}`, `PAYOFF: ${p.payoff}`, `CLOSE: ${p.close}`].join("\n");
}

/**
 * The examples of the bar (v2.6): scripts Jordan approved and sent to OTHER
 * clients, chosen at draft time by scriptWriter/barExamples (never this
 * client's, never this topic, up to three). Only their five parts are shown.
 * None qualify → no block: the writer works from the rules alone.
 */
function examplesBlock(ctx: Pick<WriterContext, "barExamples">): string {
  const xs = (ctx.barExamples ?? []).slice(0, 3);
  if (!xs.length) return "";
  return [
    `EXAMPLES OF THE BAR (${xs.length} script${xs.length === 1 ? "" : "s"} Jordan approved and sent to other clients. They show the shape and the voice: one thought from the first line to the last, short spoken sentences, a hook that lands at once. Never copy their content, lines, facts or stories.)`,
    ...xs.map((e, i) => `--- Example ${i + 1} ---\n${partsBlock(e)}`),
  ].join("\n\n");
}

/**
 * THE WRITER'S SYSTEM PROMPT (v2.6). Only what matters: the five parts and
 * what each does, her voice, the length, the close, no dashes or durations,
 * never invent and never put words in anyone else's mouth, her phrases where
 * they fit. Every other house rule is the brief's (it chooses the angle, the
 * proof, what is kept and left out) or code's (advice on the record).
 */
export const WRITER_SYSTEM = `You write ONE short video script that a real estate agent will say to camera, in her own voice, from the topic brief and her own words below.

Write the whole script as ONE thought, in five parts that follow from each other:
- HOOK: the first line. It lands on its own: the tension, surprise or question at the heart of this topic, in one breath.
- RE-HOOK: the next line raises it with something the hook did not say: a turn, a stake or a fact.
- BUILD-UP: what makes it true: her proof from the brief (what happened, or what she does), told in full spoken sentences.
- PAYOFF: the answer to the hook, in a line the viewer could repeat.
- CLOSE: a call to action tied to the message, or a line that pays off the hook.

Her voice: she is the one speaking, in the first person, the way she talks. Use her phrases where they fit.
Length: ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} spoken words.
No em dashes or en dashes. No durations or timing notes.
Never invent a fact, a number, a quote or a story, and never put words in anyone else's mouth: only what her sources say.

Any examples below are scripts Jordan approved and sent to other clients: they show the bar, in shape and voice. Never copy their content, lines, facts or stories.

Answer with one JSON object. hook, rehook, buildup, payoff and close are the five parts. title is a working title for the office. captionCta is a short written line for the caption. rationale is a one-line note each for the creative director (why the hook works, the viewer's takeaway, how her strategy shaped it), never spoken. gaps lists anything the script needed that her sources do not cover, as a question to ask her.
(${WRITER_VERSION})`;

const GAP_ITEM = obj({ kind: { type: "string", enum: ["unsupported-claim", "missing-answer", "missing-source", "unverified-history", "insufficient-context", "placeholder"] }, text: str(), question: str("The one question that would close it, or an empty string.") });

export const DRAFT_SCHEMA: JsonSchema = obj({
  title: str("A working title for the office; not spoken."),
  hook: str(),
  rehook: str(),
  buildup: str(),
  payoff: str(),
  close: str(),
  closeType: { type: "string", enum: ["cta", "callback"] },
  captionCta: str("The written contact line for the caption, or an empty string."),
  filmingNotes: str("Internal: a location, prop or delivery note when it matters, else an empty string. Never spoken, never a duration."),
  rationale: obj({ hook: str(), takeaway: str(), strategy: str() }),
  sourcesUsed: arr(str("A passage id, \"written answers\" or \"strategy\".")),
  gaps: arr(GAP_ITEM),
});

export type DraftOut = { title: string; hook: string; rehook: string; buildup: string; payoff: string; close: string; closeType: "cta" | "callback"; captionCta: string; filmingNotes: string; rationale: { hook: string; takeaway: string; strategy: string }; sourcesUsed: string[]; gaps: { kind: string; text: string; question: string }[] };

/** v2.5: the passages a writer prompt shows: never one a live deal's proof cited (brief.heldBack; it is never in the script). The review still reads them all. Pure. */
export function writerPassages(brief: Pick<TopicBrief, "heldBack"> | null | undefined, passages: readonly WriterPassage[]): WriterPassage[] {
  const held = new Set((brief?.heldBack ?? []).filter((h) => h.kind === "live").flatMap((h) => h.ids));
  return passages.filter((p) => !held.has(p.id));
}

/**
 * The brief as the writer and the reviewer read it (v2.6): the topic, what we
 * asked her, the angle, her proof, the message, the viewer, what it must keep,
 * her phrases, an agreed format, what is left out and the close. The brief's
 * other lists (optional points, facts, opinions, contradictions, our
 * assumptions) stay on the record: the writer is not asked to use them all.
 */
export function writerBriefText(ctx: Pick<WriterContext, "topic">, b: TopicBrief): string {
  const format = (b.creativeIdeas ?? []).find((x) => /\bagreed\b[^.]{0,40}\bformat\b/i.test(x.text))?.text ?? null;
  const proof = b.proof?.text ? b.proof.text : "None from her: the message itself, in her words, carries it. Do not make a story up.";
  return [
    "THIS VIDEO",
    `Topic (a label, not a line to say): ${ctx.topic.title}`,
    ...(b.whatWeAsked ? [`What we asked her: ${b.whatWeAsked}`] : []),
    ...(b.angle ? [`The angle: ${b.angle}`] : []),
    `Her proof: ${proof}`,
    `The message: ${b.centralMessage}`,
    `Who it is for: ${b.viewer}`,
    ...(b.mustKeep.length ? ["It must keep:", ...b.mustKeep.map((m) => `- ${m.text}`)] : []),
    ...((b.herPhrases ?? []).length ? ["Her phrases (use them where they fit):", ...(b.herPhrases ?? []).map((x) => `- "${x.text}"`)] : []),
    ...(format ? [/^agreed format\b/i.test(format) ? format : `Agreed format: ${format}`] : []),
    ...(b.excluded.length ? ["Leave out:", ...b.excluded.map((x) => `- ${x.text} (${x.reason})`)] : []),
    `The close: ${b.closeType === "callback" ? "a line that pays off the hook (a soft invitation is still welcome)" : "a call to action tied to the message"}.`,
    ...(b.videoType === "story" ? [`It is her told personal story: tell it in the order it happened. It may run to ${WRITER_LENGTH.cap} words, never padded.`] : []),
  ].join("\n");
}

/** Her own words as the writer reads them (v2.6): the verbatim quotes, without the lines around them. */
function herWordsBlock(passages: readonly WriterPassage[]): string {
  if (!passages.length) return "HER OWN WORDS ON THIS: nothing on record beyond the brief. Say nothing about her experience that the brief does not give.";
  return ["HER OWN WORDS ON THIS (verbatim from her calls: the material, not lines to paste):", ...passages.map((p) => `[${p.id}] "${p.quote}" (${p.source}${p.time ? ` at ${p.time}` : ""})`)].join("\n");
}

/** How she sounds (v2.6): at most two of her earlier scripts on other subjects. */
function voiceBlock(ctx: Pick<WriterContext, "voiceRefs">): string {
  const xs = ctx.voiceRefs.slice(0, 2);
  if (!xs.length) return "";
  return ["HOW SHE SOUNDS ON CAMERA (her earlier scripts; her voice, never their lines or their stories):", ...xs.map((s) => `--- ${s.title} ---\n${s.text}`)].join("\n");
}

/**
 * The writer's user message (v2.6), the same for the draft, the rewrite and a
 * revision of one script: who is speaking and the bar (cached), then this
 * video's brief and her words (cached). Pure.
 */
function writerUser(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[]): string[][] {
  return [
    [
      `CLIENT: ${ctx.clientName}. She is the one speaking.`,
      ctx.guardBlock,
      (ctx.boundaries ?? []).length ? ["HER BOUNDARIES (never cross these):", ...(ctx.boundaries ?? []).map((b) => `- ${b}`)].join("\n") : "",
      examplesBlock(ctx),
    ],
    [
      writerBriefText(ctx, brief),
      herWordsBlock(writerPassages(brief, passages)),
      answersBlock(ctx),
      voiceBlock(ctx),
      ctx.captionExamples.length ? ["HER CAPTION LINES (examples for captionCta):", ...ctx.captionExamples.slice(0, 4).map((c) => `- ${c}`)].join("\n") : "",
    ],
  ];
}

/** The draft's last line (v2.6). */
export const DRAFT_ASK = `Write the script: ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} spoken words, one thought from the first line to the last.`;

/** THE DRAFT (v2.6): one call writes all five parts. */
export function buildDraftPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[]): StepPrompt {
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, writerUser(ctx, brief, passages), [DRAFT_ASK]);
}

/** The rewrite's last line (v2.6): the whole script again, never a part patch. */
export const REWRITE_ASK = `Write the script again, whole, as one thought from the first line to the last: ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} spoken words. Do not patch the old version part by part; keep a line of it only where it still belongs in the new one.`;

/**
 * THE ONE WHOLE REWRITE (v2.6): the version that did not work and why (the
 * reviewer's note as a viewer, and code's reasons), then the whole script
 * again. Nothing is locked or copied back.
 */
export function buildRewritePrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], previous: { versionNo: number; body: string }, why: string): StepPrompt {
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, writerUser(ctx, brief, passages), [
    `THE VERSION THAT DID NOT WORK (v${previous.versionNo}):\n${previous.body.trim()}`,
    `WHY (a viewer's read of it, and code's checks):\n${why.trim()}`,
    REWRITE_ASK,
  ]);
}

/** A person's or a client's revision, or a person's length trim: the current version and the instruction (kept whole). */
export function buildReviseWriterPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], current: { versionNo: number; body: string }, instruction: string, opts: { lockedLabels?: string[]; who: "trim" | "person" | "client" }): StepPrompt {
  const whose = opts.who === "trim" ? "THE TRIM INSTRUCTION" : opts.who === "client" ? "THE CLIENT'S REQUEST (a creative input: keep her legitimate intent and her facts; it does not decide the structure, the length or the topic)" : "THE CREATIVE DIRECTOR'S INSTRUCTION";
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, writerUser(ctx, brief, passages), [
    `CURRENT VERSION (v${current.versionNo}):\n${current.body}`,
    `${whose}:\n${instruction.trim()}`,
    [
      "REVISION RULES: change what the instruction asks and keep every other line where you can; the script still reads as one thought.",
      ...(opts.who === "client" ? ["Neither version wins automatically: keep the strongest facts and wording of each, on the topic's one message."] : []),
      "When the instruction contradicts what she said (a date, an order of events, a reason), follow the instruction for the script and add a gap that names the contradiction; never invent a reconciliation.",
      ...(opts.lockedLabels?.length ? [`KEEP EXACTLY (copied back word for word after you answer; return them unchanged): ${opts.lockedLabels.join(", ")}.`] : []),
      "Return the whole script, the rationale for this version and any gaps.",
    ].join("\n"),
  ]);
}

// ---------------------------------------------------------------------------
// 4. The review (v2.6): it reads the script as a viewer FIRST
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM = `You read ONE short video script the way a viewer would hear it, before anything else. A real estate agent will say it to camera, in her own voice. You did not write it.

Read the SCRIPT once, start to finish, as someone scrolling would hear it. Then answer four questions, each pass or fail with one specific reason:
- sense: does it make sense from start to finish as ONE thought? Each line follows from the one before; nothing contradicts itself; no fragments a person would not say.
- voice: would THIS agent say it, in these words? She is the one speaking, in the first person. A line in a client's or a viewer's voice that she would not say as herself fails, and so do words she would not use.
- hook: does the hook land in the first line, on its own? Do the re-hook, the build-up and the payoff follow from it, so the payoff answers it?
- invented: is anything invented? Check every fact, number, story and quote against her sources below (her words, THE FULL CALL, her facts, her written answers); a faithful paraphrase counts. A story she did not tell, a number she did not give, or words put in someone's mouth that she never reported fail.

reads: 1 to 10, how well it works for a viewer as one thought, against the bar of the examples (10: film it as written; 5: it works, but a viewer would drift; 3 or under: it does not make sense).
note: when any question fails, ONE note to the writer about the script as a whole: what is wrong and what the rewrite should do, from her sources only. Never a list of parts to patch. An empty string when all four pass.
summary: one sentence on the script.
Judge what is on the page. A fact her sources do not have is not a fault when the script leaves it out; inventing one is.`;

const ANSWER = obj({ pass: { type: "boolean" }, reason: str("One specific reason.") });
export const REVIEW_SCHEMA: JsonSchema = obj({
  sense: ANSWER,
  voice: ANSWER,
  hook: ANSWER,
  invented: ANSWER,
  reads: { type: "integer", description: "1 to 10: how well it works for a viewer as one thought." },
  note: str("When any question fails: one note on the script as a whole for the rewrite. Else an empty string."),
  summary: str(),
});
export type ReviewOut = { sense?: { pass?: boolean; reason?: string }; voice?: { pass?: boolean; reason?: string }; hook?: { pass?: boolean; reason?: string }; invented?: { pass?: boolean; reason?: string }; reads?: number; note?: string; summary?: string };

/**
 * The review's prompt (v2.6). Two cached segments: who is speaking, the bar
 * and the full call (the same for a month's topics from one call); then this
 * video's brief and her sources (the same for both reviews of one script).
 * The script comes last, and nothing of code's checks is shown: the reviewer
 * reads it as a viewer first.
 */
export function buildReviewPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], script: { body: string }, callText: string | null = null): StepPrompt {
  return segmented(REVIEW_SYSTEM, REVIEW_SCHEMA, [
    [`CLIENT: ${ctx.clientName}. She is the one speaking.`, ctx.strategyText ? `HER APPROVED STRATEGY (a source for claims about her, never script material on its own):\n${ctx.strategyText}` : "", examplesBlock(ctx), fullCallBlock(callText)],
    [writerBriefText(ctx, brief), passagesBlock(passages), answersBlock(ctx), factsBlock(ctx.facts)],
  ], [
    `SCRIPT:\n${script.body}`,
    "Read it as a viewer first, start to finish. Then answer the four questions, the read, the note and the summary.",
  ]);
}
