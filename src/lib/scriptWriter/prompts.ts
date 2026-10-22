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
//   3. hooks      five hooks, each with its re-hook, scored on seven points;
//                 code picks the winner                           (high)
//   4. draft      the five-part script from the brief and the winning hook;
//                 the same system prompt writes every fix, trim and revision
//                                                                 (high)
//   5. review     the independent creative review: Jordan's 12 checks, pass
//                 or fail with a reason, and one fix instruction  (high)
//
// Structured outputs: every object has additionalProperties false and lists
// every property as required; counts are checked by code, not the schema.
// No dash is used as punctuation in any prompt text: the model mirrors it.
// ---------------------------------------------------------------------------

import { CLOSE_RULE, HOMEOWNER_LANGUAGE_RULE, TOPIC_LABEL_RULE, ASSUMPTION_RULE, BACKGROUND_RULE, NO_DURATION_RULE, NO_DASH_RULE, LENGTH_RULE, NEITHER_WINS_RULE, REVIEW_CHECKS, HOOK_CRITERIA, WRITER_LENGTH, WRITER_VERSION, estimateSeconds } from "./rules";
import type { TopicBrief, WriterFact, WriterPassage } from "./record";

export type JsonSchema = Record<string, unknown>;
export type StepPrompt = { system: string; prompt: string; schema: JsonSchema };

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

const TARGET_LINE = `TARGET LENGTH: ${WRITER_LENGTH.aim[0]} to ${WRITER_LENGTH.aim[1]} spoken words (about ${estimateSeconds(WRITER_LENGTH.aim[0])} to ${estimateSeconds(WRITER_LENGTH.aim[1])} seconds); ${WRITER_LENGTH.cap} is the hard cap.`;

// ---------------------------------------------------------------------------
// 1. Retrieval
// ---------------------------------------------------------------------------

export const RETRIEVAL_SYSTEM = `You read call transcripts for ONE video topic of a Realtour Pilot client (a real estate professional), and you return, verbatim, every passage where the CLIENT talks about that topic.

WHAT TO RETURN
- Every passage where the client discusses this topic or the experience, process, opinion, story or example behind it: not only the line where she agreed to film it. Read the whole call; the useful part is often minutes away from where the topic was named.
- Each quote is the transcript's own words, copied exactly and contiguously (60 to 600 characters). Never paraphrase, never join two places into one quote, never fix her grammar. A quote that is not in the transcript is thrown away.
- Name the source id the quote comes from and who is speaking (client, us = Realtour Pilot staff such as Jordan, other = anyone else).
- Lines spoken by Realtour Pilot staff are prompts and suggestions, never her experience; return one only when it is needed to understand her answer, marked speaker "us".

DISCERNMENT (forViewer)
- forViewer true: something a buyer or a seller would benefit from hearing: her experience, her process, her opinions, her stories, client situations she describes without private details, how she protects or advises people.
- forViewer false, with the reason: internal talk (scheduling, filming logistics, editing, our pricing, billing or contract, the content plan itself), private personal details, other clients by name, complaints about Realtour Pilot, anything said in confidence.
- Keep the passage either way; the reason is how the writer knows what to leave out.

The topic title and our assumptions about it are search aids, not facts. Return passages in transcript order.`;

export const RETRIEVAL_SCHEMA: JsonSchema = obj({
  passages: arr(obj({
    sourceId: str("The id in brackets before the source text, e.g. c1 or o2."),
    speaker: { type: "string", enum: ["client", "us", "other"] },
    kind: { type: "string", enum: ["experience", "process", "opinion", "story", "client_example", "creative_idea", "fact", "agreement"] },
    quote: str("Verbatim from the source, contiguous, 60 to 600 characters."),
    forViewer: { type: "boolean" },
    reason: str("When forViewer is false: why a viewer should not hear it. Otherwise an empty string."),
    why: str("One short line: what this passage gives the script."),
  })),
  overview: str("Two or three sentences: what she actually said about this topic overall."),
});

export function buildRetrievalPrompt(ctx: WriterContext, sources: SourceDoc[]): StepPrompt {
  const prompt = [
    `CLIENT: ${ctx.clientName}. In transcripts she appears as: ${ctx.speakerNames.join(", ") || "(her name)"}.`,
    topicBlock(ctx),
    "",
    ...sources.map((s) => `[${s.id}] ${s.label}\n${s.text}`),
  ].join("\n\n");
  return { system: RETRIEVAL_SYSTEM, prompt, schema: RETRIEVAL_SCHEMA };
}

// ---------------------------------------------------------------------------
// 2. Topic brief
// ---------------------------------------------------------------------------

export const BRIEF_SYSTEM = `You write the TOPIC BRIEF for ONE monthly personal-brand video of a Realtour Pilot client (a real estate professional), before anyone writes the script. Realtour Pilot leads the creative direction; the client supplies the expertise, the experiences and the voice. The brief is how the writer and the reviewer know what this video must say, and what it must not.

Decide:
- centralMessage: the ONE thing the viewer should understand, feel or do afterwards, in plain words. Understand what the topic is really about; the title's wording is not the message.
- viewer: the one person this is for, in plain words (a homeowner thinking of selling, a first-time buyer), never a demographic.
- whyChosen: why this topic was picked, from what you are told (her call, her portal pick, the month's priorities, the pillar).
- pillar: the linked content pillar.
- whatSheSaid: the passage ids (P1, P2 ...) that carry her actual words on this, most important first.
- mustKeep: the facts, process steps and phrases of hers the script cannot lose, each with its source id.
- optional: good material that can go if length needs it.
- excluded: what stays out and why (internal talk, background reasoning she did not present as her message, a second topic, a detail that would make it a biography, anything private).
- contradictions: places where her sources disagree with each other or with our assumptions. Flag them; never resolve one by inventing an answer.
- verifiedFacts / opinions / creativeIdeas / ourAssumptions: kept apart. A verified fact is something she stated as true about herself, her work or her process (a passage, a fact, her answers). An opinion is her view. A creative idea is a hook, line or angle she suggested. Our assumptions are the topic's description, intended message, audience need and business goal, and anything you infer: never a claim source.
- closeType: "cta" (a natural spoken next step tied to the topic) or "callback" (the close returns to the hook's idea and resolves it), whichever this message needs, and closeWhy in one line.

${TOPIC_LABEL_RULE}
${ASSUMPTION_RULE}
${BACKGROUND_RULE}
${CLOSE_RULE}
${TARGET_LINE}

Personal stories: her real chronology and her real reasons, one story and one turn, never a full biography and never an invented motivation. Educational topics: her actual process and a meaningful contrast, balanced (explain the challenge without creating fear), no invented analogies.`;

export const BRIEF_SCHEMA: JsonSchema = obj({
  centralMessage: str(),
  viewer: str(),
  whyChosen: str(),
  pillar: str(),
  whatSheSaid: arr(str("A passage id, e.g. P2.")),
  mustKeep: arr(ITEM),
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

export function buildBriefPrompt(ctx: WriterContext, passages: WriterPassage[], excluded: { quote: string; source: string; reason: string }[], overview: string | null): StepPrompt {
  const prompt = [
    clientBlock(ctx),
    topicBlock(ctx),
    overview ? `WHAT SHE SAID OVERALL (a reader's summary of the calls, for orientation only): ${overview}` : "",
    passagesBlock(passages),
    excluded.length ? ["PASSAGES HELD BACK (not for a viewer; the reason is why):", ...excluded.slice(0, 12).map((e) => `- ${e.source}: "${e.quote.slice(0, 200)}" (${e.reason})`)].join("\n") : "",
    answersBlock(ctx),
    factsBlock(ctx.facts),
    scriptsBlock({ ...ctx, voiceRefs: [] }),
  ].filter(Boolean).join("\n\n");
  return { system: BRIEF_SYSTEM, prompt, schema: BRIEF_SCHEMA };
}

/** The brief as every later step reads it. */
export function briefText(b: TopicBrief): string {
  const items = (label: string, xs: { text: string; source: string }[]) => (xs.length ? [`${label}:`, ...xs.map((x) => `- ${x.text} [${x.source}]`)] : []);
  return [
    "TOPIC BRIEF",
    `Central message: ${b.centralMessage}`,
    `Viewer: ${b.viewer}`,
    `Why chosen: ${b.whyChosen}`,
    `Pillar: ${b.pillar}`,
    `Close: ${b.closeType === "cta" ? "a call to action (a natural spoken next step tied to the topic)" : "a callback to the hook"}. ${b.closeWhy}`,
    `Target: ${b.target.aim[0]} to ${b.target.aim[1]} spoken words (about ${b.target.seconds[0]} to ${b.target.seconds[1]} seconds); ${b.target.cap} is the cap.`,
    ...(b.whatSheSaid.length ? ["What she said (verbatim):", ...b.whatSheSaid.map((p) => `- [${p.passageId}] "${p.quote}" (${p.source}${p.time ? ` at ${p.time}` : ""})`)] : []),
    ...items("Must keep", b.mustKeep),
    ...items("Optional", b.optional),
    ...(b.excluded.length ? ["Excluded:", ...b.excluded.map((x) => `- ${x.text} (${x.reason})`)] : []),
    ...(b.contradictions.length ? ["Contradictions (flagged, not resolved):", ...b.contradictions.map((x) => `- ${x.text} [${x.sources}]`)] : []),
    ...items("Verified facts", b.verifiedFacts),
    ...items("Her opinions", b.opinions),
    ...items("Her creative ideas", b.creativeIdeas),
    ...items("Our assumptions (never a claim source)", b.ourAssumptions),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. Five hooks
// ---------------------------------------------------------------------------

export const HOOKS_SYSTEM = `You write FIVE hooks for ONE monthly personal-brand video of a Realtour Pilot client (a real estate professional), each with the re-hook that would follow it, and you score each one honestly. The best one will be chosen by its scores; do not inflate them.

A HOOK captures attention in one breath (about 6 to 16 spoken words): a relatable belief or misconception the viewer holds, an unexpected contrast, a question the viewer is already asking, a real problem, or a compelling moment from her own experience. Prefer a line the viewer might say themselves. Never a greeting, never her name, never "Today I want to talk about", never "Here are 3 tips", never opening by naming the audience ("Sellers, ...").
A RE-HOOK gives a new reason to keep watching: a turn, a tension, a surprising detail, a shift in perspective. It never restates the hook in other words, and it sets up what the payoff will prove.
Make the five genuinely different (different levers, different first words), all true to the brief: nothing her sources do not support.

SCORE each hook 1 to 5 on: relevance (immediately relevant to the viewer), curiosity, specificity, naturalDelivery (easy to say out loud, sounds like a person), accuracy (5 = fully supported by her sources; under 4 = it claims or implies something she did not say), herVoice, payoffConnection (the payoff in the brief answers it). One short note per hook.

${HOMEOWNER_LANGUAGE_RULE}
${TOPIC_LABEL_RULE}
${NO_DASH_RULE}`;

export const HOOKS_SCHEMA: JsonSchema = obj({
  hooks: arr(obj({
    text: str("The hook, spoken."),
    rehook: str("The re-hook that would follow it, spoken."),
    lever: str("The lever in two or three words (belief, contrast, question, real problem, her moment ...)."),
    scores: obj(Object.fromEntries(HOOK_CRITERIA.map((k) => [k, { type: "integer" }]))),
    note: str(),
  }), "Exactly five."),
});

export function buildHooksPrompt(ctx: WriterContext, brief: TopicBrief): StepPrompt {
  const prompt = [
    clientBlock(ctx, { strategy: false }),
    topicBlock(ctx),
    briefText(brief),
    factsBlock(ctx.facts),
    scriptsBlock({ ...ctx, relatedScripts: [] }),
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
- HOOK: capture attention immediately with a relatable belief, an unexpected contrast, an interesting question, a real problem or a compelling moment of hers. No generic introduction, no greeting, no name.
- RE-HOOK: a new reason to keep watching: curiosity, contrast, tension, a surprising detail or a shift in perspective. Never a restatement of the hook.
- BUILD-UP: enough context for the viewer to understand, with concrete examples and her actual expertise; no excess explanation.
- PAYOFF: deliver what the hook promised: a realisation, practical advice, her process, or a personal insight. It establishes credibility, trust or connection.
- CLOSE: complete the message naturally.
${CLOSE_RULE}

${LENGTH_RULE}
${HOMEOWNER_LANGUAGE_RULE}
${TOPIC_LABEL_RULE}
${ASSUMPTION_RULE}
${BACKGROUND_RULE}

TRUTH: never invent a story, a client event, a number, a result, a credential, a market statistic, a motivation or an analogy she did not give. Never add a market claim because it sounds plausible. What the sources do not support becomes a gap (kind, text, question) and the script says nothing about it.
PERSONAL STORIES: her real chronology and her real reasons, in order; one compelling story with one turn, not a biography; keep the emotionally meaningful words she uses about her purpose; give the viewer a reason to trust or remember her.
EDUCATIONAL: actionable information, not generic advice; show what she does differently and keep the specific details of her process; use a meaningful contrast; balanced, explaining the challenge without creating fear.
HER VOICE: her words and phrases where they fit, the way she would say it across the table. Her rewrites and her lines are strong evidence for how it should sound; they do not decide the structure, the length or the topic.
${NEITHER_WINS_RULE}
EVIDENCE, NOT COPY: the passages are evidence; choose the strongest details, do not reproduce the conversation.

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

function writerUser(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], chosen: { text: string; rehook: string } | null): string {
  return [
    clientBlock(ctx),
    topicBlock(ctx),
    briefText(brief),
    passagesBlock(passages),
    answersBlock(ctx),
    factsBlock(ctx.facts),
    scriptsBlock(ctx),
    ctx.captionExamples.length ? ["HER CAPTION CTA EXAMPLES:", ...ctx.captionExamples.map((c) => `- ${c}`)].join("\n") : "",
    chosen ? `THE CHOSEN HOOK (use it word for word): ${chosen.text}\nTHE CHOSEN RE-HOOK (build the re-hook from it): ${chosen.rehook}` : "",
  ].filter(Boolean).join("\n\n");
}

export function buildDraftPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], chosen: { text: string; rehook: string } | null): StepPrompt {
  return { system: WRITER_SYSTEM, prompt: `${writerUser(ctx, brief, passages, chosen)}\n\nWrite the script.`, schema: DRAFT_SCHEMA };
}

/** A fix round, the trim pass, or a person's revision: the same writer, the current version and the instruction (kept whole). */
export function buildReviseWriterPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], current: { versionNo: number; body: string }, instruction: string, opts: { lockedLabels?: string[]; who: "review" | "trim" | "person" | "client" }): StepPrompt {
  const whose = opts.who === "review" ? "THE INDEPENDENT REVIEW'S FIX INSTRUCTION" : opts.who === "trim" ? "THE TRIM INSTRUCTION" : opts.who === "client" ? "THE CLIENT'S REQUEST (a creative input: keep her legitimate intent and her facts; it does not decide the structure, the length or the topic)" : "THE CREATIVE DIRECTOR'S INSTRUCTION";
  const prompt = [
    writerUser(ctx, brief, passages, null),
    `CURRENT VERSION (v${current.versionNo}):\n${current.body}`,
    `${whose}:\n${instruction.trim()}`,
    [
      "REVISION RULES: change what the instruction asks and keep every other line word for word where you can. Keep the hook unless the instruction is about the hook.",
      "Check the instruction against her sources. When it contradicts what she said (a date, an order of events, a reason), follow the instruction for the script and add a gap that names the contradiction; never invent a reconciliation.",
      ...(opts.lockedLabels?.length ? [`KEEP EXACTLY (copied back word for word after you answer; return them unchanged): ${opts.lockedLabels.join(", ")}.`] : []),
      "Return the whole script, the rationale for this version and any gaps.",
    ].join("\n"),
  ].join("\n\n");
  return { system: WRITER_SYSTEM, prompt, schema: DRAFT_SCHEMA };
}

// ---------------------------------------------------------------------------
// 5. The independent creative review
// ---------------------------------------------------------------------------

export const REVIEW_SYSTEM = `You are the INDEPENDENT CREATIVE REVIEWER for ONE monthly personal-brand video script written for a Realtour Pilot client (a real estate professional). You did not write it. You judge it against its topic brief and against what the client actually said: the full source passages with the lines around them, her facts and her written answers, not only the quotes the writer picked.

Score every check pass or fail with one specific reason. No inflated scores: a script is not good because it reads smoothly. Fail a check for a real problem the creative director would send back; pass it otherwise.
${REVIEW_CHECKS.map((c) => `${c.n}. ${c.key} (${c.label}, ${c.level}): passes when ${c.passes}`).join("\n")}

HOW TO JUDGE
- her_meaning: compare against the passages in full. A reason, a sequence of events or a claim bent away from what she said fails, and so does a chronology that does not match her account.
- substance: every must-keep item in the brief is present in substance (her words or a faithful plain version). Missing one fails. A script under ${WRITER_LENGTH.aim[0]} words passes only if nothing must-keep is missing and it is not dry or incomplete.
- claims: each factual line traces to a passage, a client fact, her written answers or her approved strategy. The topic description, intended message, audience need, business goal and anything marked "our assumption" do not count. A market statement she did not make fails.
- close: it must be the close type the brief chose (a natural call to action, or a callback that resolves the hook). A slogan or an aphorism fails this check.
- her_voice: industry terms spoken to homeowners ("buyer avatar", "comps", "CMA") fail; opening by naming the audience ("Sellers, ...") fails.
- length: counted by code and given to you; judge only whether the words are well spent (that is check 12). Over ${WRITER_LENGTH.cap} words is must-fix; ${WRITER_LENGTH.aim[1] + 1} to ${WRITER_LENGTH.cap} is advice only.
- You never ask for anything to be invented. A missing fact the sources do not have is a gap, not a reason to fail substance, unless the brief marked it must-keep.

fixInstruction: when any check fails, one instruction to the writer saying exactly what to change, using only the sources (and, over the cap, what to cut). An empty string when everything passes. summary: one sentence on the script overall.`;

export const REVIEW_SCHEMA: JsonSchema = obj({
  checks: arr(obj({ key: { type: "string", enum: REVIEW_CHECKS.map((c) => c.key) }, pass: { type: "boolean" }, reason: str() }), "All twelve checks, each once."),
  fixInstruction: str(),
  summary: str(),
});

export function buildReviewPrompt(ctx: WriterContext, brief: TopicBrief, passages: WriterPassage[], script: { body: string; closeType: string | null }, numbers: { words: number; seconds: number; hookWords: number; hard: string[] }): StepPrompt {
  const prompt = [
    clientBlock(ctx),
    topicBlock(ctx),
    briefText(brief),
    passagesBlock(passages),
    answersBlock(ctx),
    factsBlock(ctx.facts),
    ctx.relatedScripts.length ? scriptsBlock({ ...ctx, voiceRefs: [] }) : "",
    `SCRIPT TO REVIEW:\n${script.body}`,
    `THE WRITER SAYS THE CLOSE IS: ${script.closeType ?? "not stated"}`,
    `COUNTED BY CODE: ${numbers.words} spoken words, about ${numbers.seconds} seconds; hook ${numbers.hookWords} words.${numbers.hard.length ? ` Hard checks that failed: ${numbers.hard.join(" ")}` : " Hard checks: no greeting, no dash, no duration, no unsupported figure."}`,
    "Review it: all twelve checks.",
  ].filter(Boolean).join("\n\n");
  return { system: REVIEW_SYSTEM, prompt, schema: REVIEW_SCHEMA };
}
