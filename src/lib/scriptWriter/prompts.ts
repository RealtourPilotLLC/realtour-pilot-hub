// ---------------------------------------------------------------------------
// THE SCRIPT WRITER'S PROMPTS (Oct 22 2026). Pure: strings and JSON schemas,
// no provider call. Five steps, each its own system prompt (stable, so the API
// caches it) and its own structured-output schema:
//
//   1. retrieval  read the topic's call(s) in full and older call windows;
//                 quote, verbatim, every passage where the client talks about
//                 this topic; mark what a buyer or seller should hear and what
//                 is internal talk                                (medium)
//   2. brief      the topic brief: one message, viewer, why chosen, what she
//                 said, must-keep / optional / excluded, contradictions, the
//                 close type; facts, opinions, ideas and OUR assumptions apart
//                                                                 (medium)
//   3. hooks      five hooks, each with its re-hook, scored on eight points
//                 (v2.3: tension added); code picks the winner    (high)
//   4. draft      the five-part script from the brief and the winning hook;
//                 the same system prompt writes every fix, trim and revision
//                                                                 (high)
//   5. review     the independent creative review: Jordan's 12 checks, pass
//                 or fail with a reason, the craft block (v2.3: the five parts
//                 scored 1 to 5, a psychology note each) and one fix
//                 instruction                                     (medium)
// The models and efforts per step: scriptWriter/pipeline STEP_MODEL and
// STEP_EFFORT. v2.3: each user message is built in segments (StepPrompt
// blocks): the long stable material first, ending in a cache breakpoint, the
// per-round material after.
//
// Structured outputs: every object has additionalProperties false and lists
// every property as required; counts are checked by code, not the schema.
// No dash is used as punctuation in any prompt text: the model mirrors it.
// ---------------------------------------------------------------------------

import { CLOSE_RULE, HOMEOWNER_LANGUAGE_RULE, TOPIC_LABEL_RULE, ASSUMPTION_RULE, BACKGROUND_RULE, NO_DURATION_RULE, NO_DASH_RULE, LENGTH_RULE, NEITHER_WINS_RULE, WORDING_RULE, HOUSE_CRAFT_RULES, REVIEW_CHECKS, MODEL_CHECK_KEYS, CRAFT_PARTS, HOOK_CRITERIA, WRITER_LENGTH, WRITER_VERSION, BRIEF_MUST_KEEP_MAX, estimateSeconds } from "./rules";
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

/** The draft's closing line (Oct 22 2026, v2.1): the number, plainly, and what must survive it. */
export const DRAFT_LENGTH_ASK = `Write the script in about ${WRITER_LENGTH.target} spoken words (${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]}; ${WRITER_LENGTH.cap} is the hard cap). The brief's must-keep points are the only things that must survive; optional material, a second example and extra setup go first. Never dry or incomplete. Count the spoken words before you answer.`;
/** v2.4: a told personal story may use up to the cap (Jordan's own story finals run 94 to 110). */
export const DRAFT_LENGTH_ASK_STORY = `This is her told personal story: tell it in order, in about ${WRITER_LENGTH.storyTarget} spoken words and never more than ${WRITER_LENGTH.cap} (the hard cap); never pad it to reach a number. The brief's must-keep beats are the only things that must survive. Never dry or incomplete. Count the spoken words before you answer.`;
/** The draft's closing length line for this brief (v2.4). */
export function draftLengthAsk(brief: Pick<TopicBrief, "videoType">): string {
  return brief.videoType === "story" ? DRAFT_LENGTH_ASK_STORY : DRAFT_LENGTH_ASK;
}

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
- NEVER A LIVE DEAL: an offer she just wrote, a listing she is negotiating now, a client's sale still in progress, or anything that identifies a specific listing or a person, is never must-keep. Put it in excluded (or in optional, in general terms only).
- A story she has already told on camera is never this video's proof. Her earlier scripts are listed below: when her moment is one of them, choose another moment she told, or let the insight be the proof.
- herPhrases: up to five SHORT phrases of hers (a few words each) that are strong and natural on camera and worth saying exactly (her own vocabulary, a few words that carry feeling or a picture). Never a rambling spoken sentence, and never an industry term a homeowner would not say: her phrases never override plain words.
- optional: good material that can go if length needs it.
- excluded: what stays out and why (internal talk, background reasoning she did not present as her message, a second topic, job duties and side facts that would make it a biography, anything private). Her actual reason for a career change is never excluded as "biography": it is the heart of that story. A format agreed on the call for this video is never internal talk and never excluded.
- contradictions: places where her sources disagree with each other or with our assumptions. Flag them; never resolve one by inventing an answer.
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
// 3. Five hooks
// ---------------------------------------------------------------------------

export const HOOKS_SYSTEM = `You write FIVE hooks for ONE monthly personal-brand video of a Realtour Pilot client (a real estate professional), each with the re-hook that would follow it, and you score each one honestly. The best one will be chosen by its scores; do not inflate them.

A HOOK captures attention in one breath (about 6 to 16 spoken words): a relatable belief or misconception the viewer holds, an unexpected contrast, a question the viewer is already asking, a real problem, or a compelling moment from her own experience. It carries its own tension: a cost, a reversal or an unanswered question. A bare wish or belief with nothing at stake is not a hook. Never a greeting, never her name, never "Today I want to talk about", never "Here are 3 tips", never opening by naming the audience ("Sellers, ...").
A RE-HOOK adds a fact, a turn or a stake that is not in the hook, and sets up what the payoff will prove. It never opens with a hedge (Maybe, Not exactly), never restates the hook's subject in other words, and never only explains why the hook is true.
Make the five genuinely different (different levers, different first words, different shapes), all true to the brief: nothing her sources do not support. At most two of the five are a viewer's sentence spoken in the first person. When this month's other videos are listed, open this one differently from all of them.

THE HOOK DOES THE VIDEO'S JOB (the brief says which video this is):
- A PERSONAL STORY opens on HER moment: the tension or the turn in her own story, in her voice (what she loved and left, what she expected and what happened instead, the question her story answers). Not a line a viewer would say, not a question to the viewer: the viewer leans in because something happened to her. At least three of the five hooks are her moment.
- An EDUCATIONAL video voices the viewer's own belief or misconception, in the words a homeowner or buyer would actually say, or a question they are already asking; the interviewer's question (the brief's "what we asked") is often the best way in.
- A fun fact about her is a weak hook.
fit: "her_moment" when the hook opens on her own tension or turn, "viewer_line" when it is a line the viewer would say or a question they are asking, "other" otherwise. For a personal story the best her_moment hook is chosen first; score honestly anyway.

SCORE each hook 1 to 5 on: relevance (immediately relevant to the viewer), curiosity, tension (5 = a real cost, reversal or unanswered question is at stake for the viewer or for her; 1 = a bare wish or belief with nothing at stake), specificity, naturalDelivery (easy to say out loud, sounds like a person), accuracy (5 = fully supported by her sources; under 4 = it claims or implies something she did not say), herVoice, payoffConnection (the brief's central message answers it). A hook is only chosen when its curiosity and its tension are both strong, and the hooks are ranked by curiosity, tension and specificity: score those three with care, never generously. One short note per hook.

${WORDING_RULE}
${HOUSE_CRAFT_RULES}
${HOMEOWNER_LANGUAGE_RULE}
${TOPIC_LABEL_RULE}
${NO_DASH_RULE}`;

export const HOOKS_SCHEMA: JsonSchema = obj({
  hooks: arr(obj({
    text: str("The hook, spoken."),
    rehook: str("The re-hook that would follow it, spoken."),
    lever: str("The lever in two or three words (belief, contrast, question, real problem, her moment ...)."),
    fit: { type: "string", enum: ["her_moment", "viewer_line", "other"] },
    scores: obj(Object.fromEntries(HOOK_CRITERIA.map((k) => [k, { type: "integer" }]))),
    note: str(),
  }), "Exactly five."),
});

/** v2.3: `siblings` are the hooks this month's other scripts for her open with (variety: never the same way twice). */
export function buildHooksPrompt(ctx: WriterContext, brief: TopicBrief, opts: { siblings?: readonly string[] } = {}): StepPrompt {
  const siblings = (opts.siblings ?? []).filter(Boolean);
  const prompt = [
    clientBlock(ctx, { strategy: false }),
    topicBlock(ctx),
    briefText(brief),
    factsBlock(ctx.facts),
    scriptsBlock({ ...ctx, relatedScripts: [] }),
    siblings.length ? ["THIS MONTH'S OTHER VIDEOS FOR HER OPEN WITH (open this one differently: a different lever, different first words, a different shape; never reuse one):", ...siblings.map((h) => `- ${h}`)].join("\n") : "",
    "Write exactly five hooks, each with its re-hook, and score them.",
  ].filter(Boolean).join("\n\n");
  return { system: HOOKS_SYSTEM, prompt, schema: HOOKS_SCHEMA };
}

// ---------------------------------------------------------------------------
// 4. The writer (draft, fix, trim, revise)
// ---------------------------------------------------------------------------

export const WRITER_SYSTEM = `You write ONE monthly personal-brand video script for a Realtour Pilot client (a real estate professional), from a topic brief. Realtour Pilot leads the creative direction; the client supplies the expertise, the experiences and the voice. The script turns her knowledge, stories and perspective into a short video a viewer would watch to the end, trust, and remember her by. It is not a listing video: never sell a property.
(${WRITER_VERSION})

THE FRAMEWORK: HOOK, RE-HOOK, BUILD-UP, PAYOFF, CLOSE.
- HOOK: capture attention immediately with a relatable belief, an unexpected contrast, an interesting question, a real problem or a compelling moment of hers, carrying its own tension (a cost, a reversal or an unanswered question). No generic introduction, no greeting, no name.
- RE-HOOK: a fact, a turn or a stake that is not in the hook: it raises the tension. Never opens with a hedge (Maybe, Not exactly), never restates the hook's subject in other words, never only explains why the hook is true.
- BUILD-UP: enough context for the viewer to understand, built on her one real moment (the brief's proof: what happened, one number or detail, how it ended) and her actual expertise; no excess explanation.
- PAYOFF: answer the hook's question in one line the viewer could repeat, then why it matters to them. How she helps appears once, in the payoff or the close, never both. A "My job is" or credential line that does not answer the hook is not a payoff.
- CLOSE: complete the message naturally, by the close rule below.
${CLOSE_RULE}

${WORDING_RULE}
${HOUSE_CRAFT_RULES}

${LENGTH_RULE}
${HOMEOWNER_LANGUAGE_RULE}
${TOPIC_LABEL_RULE}
${ASSUMPTION_RULE}
${BACKGROUND_RULE}

TRUTH: never invent a story, a client event, a number, a result, a credential, a market statistic, a motivation or an analogy she did not give. Never add a market claim because it sounds plausible. A faithful paraphrase of what she said is supported. What the sources do not support becomes a gap (kind, text, question) and the script says nothing about it.
HER VOICE: her vocabulary and her strongest short phrases (the brief's "her phrases"), in sentences written for camera: short, natural, polished, the way she would say it on her best take across the table. Her rewrites and her lines are strong evidence for how it should sound; they do not decide the structure, the length or the topic.
${NEITHER_WINS_RULE}
EVIDENCE, NOT COPY: the passages are evidence of what she means; choose the strongest points and write them, do not reproduce the conversation.

THE HOOK: use the chosen hook exactly as given unless your instruction says to change it. Build the re-hook from the chosen re-hook so it adds something new and sets up the payoff.
PUNCTUATION: ${NO_DASH_RULE}
${NO_DURATION_RULE}

OUTPUT: one JSON object matching the schema. rehook, buildup and payoff are the three talking points, in that order. rationale is a short internal note for the creative director, one sentence each: why this hook works, the viewer's takeaway, and how her strategy shaped the script. It is never spoken and never shown to the client. captionCta is the written contact line for the caption, in the style of her caption examples when there are any.`;

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
  sourcesUsed: arr(str("A passage or fact id, \"written answers\" or \"strategy\".")),
  gaps: arr(GAP_ITEM),
});

export type DraftOut = { title: string; hook: string; rehook: string; buildup: string; payoff: string; close: string; closeType: "cta" | "callback"; captionCta: string; filmingNotes: string; rationale: { hook: string; takeaway: string; strategy: string }; sourcesUsed: string[]; gaps: { kind: string; text: string; question: string }[] };

/**
 * What every writer prompt starts with. v2.3 (prompt caching): `stable` is
 * the client, the topic, the brief and her material, the same in the draft
 * and in every fix, trim and revision of one script, so it sits in front of a
 * cache breakpoint; `chosen` (the hook to use) is per round and goes after it.
 */
function writerUser(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], chosen: { text: string; rehook: string } | null): { stable: string[]; chosen: string } {
  return {
    stable: [
      clientBlock(ctx),
      topicBlock(ctx),
      briefText(brief),
      passagesBlock(passages),
      answersBlock(ctx),
      factsBlock(ctx.facts),
      scriptsBlock(ctx),
      ctx.captionExamples.length ? ["HER CAPTION CTA EXAMPLES:", ...ctx.captionExamples.map((c) => `- ${c}`)].join("\n") : "",
    ],
    chosen: chosen ? `THE CHOSEN HOOK (use it word for word): ${chosen.text}\nTHE CHOSEN RE-HOOK (build the re-hook from it): ${chosen.rehook}` : "",
  };
}

export function buildDraftPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], chosen: { text: string; rehook: string } | null): StepPrompt {
  const u = writerUser(ctx, brief, passages, chosen);
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, [u.stable], [u.chosen, draftLengthAsk(brief)]);
}

/** A fix round, the trim pass, or a person's revision: the same writer, the current version and the instruction (kept whole). */
export function buildReviseWriterPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], current: { versionNo: number; body: string }, instruction: string, opts: { lockedLabels?: string[]; who: "review" | "trim" | "person" | "client" }): StepPrompt {
  const whose = opts.who === "review" ? "THE INDEPENDENT REVIEW'S FIX INSTRUCTION" : opts.who === "trim" ? "THE TRIM INSTRUCTION" : opts.who === "client" ? "THE CLIENT'S REQUEST (a creative input: keep her legitimate intent and her facts; it does not decide the structure, the length or the topic)" : "THE CREATIVE DIRECTOR'S INSTRUCTION";
  const u = writerUser(ctx, brief, passages, null);
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, [u.stable], [
    `CURRENT VERSION (v${current.versionNo}):\n${current.body}`,
    `${whose}:\n${instruction.trim()}`,
    [
      "REVISION RULES: change what the instruction asks and keep every other line word for word where you can. Keep the hook unless the instruction is about the hook.",
      "Check the instruction against her sources. When it contradicts what she said (a date, an order of events, a reason), follow the instruction for the script and add a gap that names the contradiction; never invent a reconciliation.",
      ...(opts.lockedLabels?.length ? [`KEEP EXACTLY (copied back word for word after you answer; return them unchanged): ${opts.lockedLabels.join(", ")}.`] : []),
      "Return the whole script, the rationale for this version and any gaps.",
    ].join("\n"),
  ]);
}

/**
 * A fix round that starts again from the RUNNER-UP hook (Oct 22 2026, the
 * listening fix): the review failed the hook, so the round is a fresh draft
 * from the next hook, carrying the review's notes. Same system prompt and
 * schema as every draft. v2.4 (keep the good hook): the runner-up's HOOK
 * only, never its re-hook (unreviewed, it carried new claims in during the
 * retest), and `keep` names the parts that passed, kept word for word (code
 * copies them back).
 */
export function buildRedraftPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], hook: { text: string }, previous: { versionNo: number; body: string }, instruction: string, opts: { keep?: string[] } = {}): StepPrompt {
  const u = writerUser(ctx, brief, passages, null);
  return segmented(WRITER_SYSTEM, DRAFT_SCHEMA, [u.stable], [
    `THE CHOSEN HOOK (use it word for word): ${hook.text}`,
    `THE PREVIOUS VERSION (v${previous.versionNo}), which failed the review on its hook:\n${previous.body}`,
    `THE INDEPENDENT REVIEW'S FIX INSTRUCTION:\n${instruction.trim()}`,
    [
      "REDRAFT RULES: this round starts again from THE CHOSEN HOOK above (the next-best hook, not the one that failed): use it word for word, write a re-hook that adds a fact, a turn or a stake this hook does not have (from her sources only), and write the rest so every beat follows from the new opening. Keep a line of the previous version only where it still fits. Fix everything else the review names. Return the whole script, the rationale for this version and any gaps.",
      ...(opts.keep?.length ? [`KEEP EXACTLY (these passed the review; copied back word for word after you answer; return them unchanged): ${opts.keep.join(", ")}.`] : []),
    ].join("\n"),
    draftLengthAsk(brief),
  ]);
}

// ---------------------------------------------------------------------------
// 5. The independent creative review
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM = `You are the INDEPENDENT CREATIVE REVIEWER for ONE monthly personal-brand video script written for a Realtour Pilot client (a real estate professional). You did not write it. You judge it against its topic brief and against what the client actually said: the passages with the lines around them, THE FULL CALL, her facts and her written answers, not only the quotes the writer picked. The bar is the creative director's own finals: a hook with real tension, a re-hook that raises it, her own story as the proof, the insight that matters to the viewer, her voice at its best, and a close the viewer remembers because it answers the hook.

Score every check pass or fail with one specific reason. No inflated scores: a script is not good because it reads smoothly or because it repeats her words. Fail a check for a real problem the creative director would send back; pass it otherwise.
${REVIEW_CHECKS.map((c) => `${c.n}. ${c.key} (${c.label}, ${c.level}): passes when ${c.passes}`).join("\n")}

HOW TO JUDGE
- her_meaning: compare against the passages and the full call. A reason, a sequence of events or a claim bent away from what she said fails, and so does a chronology that does not match her account.
- story: for a personal story, the progression is understandable and in order (what she loved, her actual reason for the change, what she expected, the turn, the insight, how she helps now). A list of facts about her, a biography, or a story missing her real reason fails.
- rehook: it adds a fact, a turn or a stake the hook does not have. A re-hook that opens with a hedge (Maybe, Not exactly), restates the hook's subject in other words, or only explains why the hook is true fails.
- substance: every must-keep POINT of the brief is present in meaning (a faithful plain version counts), and so is the insight; how she helps appears once, in the payoff or the close, never both. Missing one fails. When she told a story about this topic (her answer when the interviewer asked for an example, or the brief's proof when it is her story), a script that leaves it out fails, and a restated opinion in its place is not the proof. A script under ${WRITER_LENGTH.aim[0]} words passes only if nothing must-keep is missing and it is not dry or incomplete.
- payoff: it answers the hook's question in one line the viewer could repeat, and lands why it matters to the viewer. A "My job" or credential line that does not answer the hook fails, and a fun fact about her (who her favorite clients are, a hobby, an award) is not a payoff.
- claims: each factual line traces to something she said ANYWHERE in the full call, a passage (a passage from one of her earlier calls is hers too), a client fact, her written answers or her approved strategy; a faithful paraphrase is supported. The topic description, intended message, audience need, business goal, anything marked "our assumption" and a reader's summary at the top of a call do not count. A market statement she did not make fails.
- close: at most two beats: first a line that calls back a concrete word or image from the hook (or from the re-hook), then, with a service angle, a warm invitation that names this video's specific next step in her voice. "Let's talk" as the whole invitation, an invitation that opens "Thinking about X?", a close with nothing from the hook, a slogan or an aphorism fails. A callback alone passes only for a story with no service angle.
- her_voice: it sounds like her at her best on camera: her vocabulary and her strongest short phrases in tight, natural, polished spoken sentences. Her transcript sentences pasted in (rambling, filler, restarts) fail; so do industry terms spoken to homeowners ("buyer avatar", "comps", "CMA"), even when they are a phrase of hers, and opening by naming the audience ("Sellers, ...").
- length: counted by code and given to you; judge only whether the words are well spent (that is check 12). Over ${WRITER_LENGTH.cap} words is must-fix; ${WRITER_LENGTH.aim[1] + 1} to ${WRITER_LENGTH.cap} is advice only.
- A format agreed on the call (word association, two voices, a trend alert) is a creative decision the script follows; following it is never a fault.
- You never ask for anything to be invented. A missing fact the sources do not have is a gap, not a reason to fail substance, unless the brief marked it must-keep.

CRAFT (check 13, the craft block): the checks above ask whether the script complies; the craft block asks whether it WORKS on a viewer. Score each part 1 to 5 with one line on the psychology behind it:
${CRAFT_PARTS.map((p) => `- ${p.key}: ${p.asks}.`).join("\n")}
5 is a part the creative director would film as written; 4 he would keep; 3 works but could be stronger (a flag, not a reason to send it back); 2 or under he would send back. The craft check passes on a total of 19 or more with no part at 2 or under. Reading smoothly, or repeating her words, is not craft. Score what is on the page, never what it could become.
TENSION is more than a cost said out loud. An implied stake (what the viewer stands to lose, left unsaid), a surprise (a turn the viewer did not see coming) and humor in a comedic format agreed on the call (a deadpan line that turns on its own words) all carry tension: score them as tension, not as its absence.
A build-up is one beat in full spoken sentences (what happened, then what changed); a list after a colon or a run of fragments is weaker than the same beat told.

fixInstruction: when any check fails or any craft part is 3 or under, one instruction to the writer saying exactly what to change, using only the sources (and, over the cap, what to cut). An empty string when everything passes. summary: one sentence on the script overall.

${WORDING_RULE}
${HOUSE_CRAFT_RULES}`;

const CRAFT_PART_SCHEMA = obj({ score: { type: "integer", description: "1 to 5." }, note: str("One line: the psychology of this part.") });
export const REVIEW_SCHEMA: JsonSchema = obj({
  checks: arr(obj({ key: { type: "string", enum: [...MODEL_CHECK_KEYS] }, pass: { type: "boolean" }, reason: str() }), "All twelve checks, each once (craft is the craft block)."),
  craft: obj(Object.fromEntries(CRAFT_PARTS.map((p) => [p.key, CRAFT_PART_SCHEMA])), "The five parts, each scored 1 to 5 with a one-line psychology note."),
  fixInstruction: str(),
  summary: str(),
});

/**
 * v2.3 (prompt caching): two stable segments, each ending in a cache
 * breakpoint: the client and the full call (the same for every review of a
 * month's topics from one call), then the topic, the brief and her material
 * (the same for every round of this script); the version under review and
 * code's numbers come after. A second review round reads both from the cache.
 */
export function buildReviewPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], script: { body: string; closeType: string | null }, numbers: { words: number; seconds: number; hookWords: number; hard: string[] }, callText: string | null = null): StepPrompt {
  return segmented(REVIEW_SYSTEM, REVIEW_SCHEMA, [
    [clientBlock(ctx), fullCallBlock(callText)],
    [
      topicBlock(ctx),
      briefText(brief),
      passagesBlock(passages),
      answersBlock(ctx),
      factsBlock(ctx.facts),
      ctx.relatedScripts.length ? scriptsBlock({ ...ctx, voiceRefs: [] }) : "",
    ],
  ], [
    `SCRIPT TO REVIEW:\n${script.body}`,
    `THE WRITER SAYS THE CLOSE IS: ${script.closeType ?? "not stated"}`,
    `COUNTED BY CODE: ${numbers.words} spoken words, about ${numbers.seconds} seconds; hook ${numbers.hookWords} words.${numbers.hard.length ? ` Hard checks that failed: ${numbers.hard.join(" ")}` : " Hard checks: no greeting, no dash, no duration, no unsupported figure, no transcript sentence pasted in, no hedge or echo in the re-hook, a close that calls back the hook or the re-hook, every part inside its budget, a build-up in full sentences."}`,
    "Review it: all twelve checks, and the craft block (the five parts scored 1 to 5, a psychology note each).",
  ]);
}
