// ---------------------------------------------------------------------------
// WHAT THE AGENT SAID, PER TOPIC (Oct 26 2026). Jordan: "I want to see a
// summary of what the agent said about the topic or what they said for
// answered questions if they went that route." His workflow before the hub:
// ChatGPT read the strategy call and wrote, per chosen topic, a detailed
// summary of what the agent said; his Scripting GPT wrote each script from that
// summary. This file is the summary's shape, the instructions that produce it,
// and the plain-text rendering Jordan reads (the layout of his Erica Walker
// October extraction). Shared by the server and the office card, so nothing
// here is server-only.
// ---------------------------------------------------------------------------

export type BriefExample = { text: string; kind: "real" | "speculation" | "hypothetical" };

/** One chosen topic, as the agent talked about it. */
export type TopicBrief = {
  topicId: string;
  title: string;
  /** False when neither the call nor the answers say anything about this topic: there is nothing to write from yet. */
  discussed: boolean;
  audience: string;
  /** Where in the call it was discussed ("46:22 to 51:44"), or "Written answers". */
  where: string | null;
  /** What the agent said, in plain words: her concern, her point, what she wants viewers to take away. */
  summary: string;
  /** The specific things she named (lists, steps, features, numbers she gave). */
  details: string[];
  /** Real stories and examples, marked real, speculation or hypothetical. */
  examples: BriefExample[];
  /** Short lines in her own words worth keeping, exactly as said. */
  herWords: string[];
  /** Ideas that came from Jordan or the strategist, not from her (production ideas, suggestions she agreed to). */
  fromStrategist: string[];
  /** What the call or answers did not establish (so the script never invents it). */
  notEstablished: string[];
  /** A recent or selected video this one must stay distinct from, and how. */
  overlap: string | null;
};

/** The whole month, the way Jordan's extraction opened and closed. */
export type MonthBrief = {
  /** "Erica selected five videos during her October 20 strategy call, confirmed at 1:13:46." */
  opening: string;
  /** Her main request for the month, in her words when she said it. */
  mainRequest: string | null;
  topics: TopicBrief[];
  /** Topics discussed and held for later, with why and the supporting ideas. */
  held: { title: string; why: string; ideas: string[] }[];
};

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["opening", "mainRequest", "topics", "held"],
  properties: {
    opening: { type: "string", description: "One or two sentences: how many videos were chosen, on what call or route, and where in the call they were confirmed (timestamp) when known." },
    mainRequest: { type: ["string", "null"], description: "The client's main request or priority for this month, with a short quote of their own words when they said it; null if none." },
    topics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topicId", "title", "discussed", "audience", "where", "summary", "details", "examples", "herWords", "fromStrategist", "notEstablished", "overlap"],
        properties: {
          topicId: { type: "string", description: "The id given for this topic, exactly." },
          title: { type: "string" },
          discussed: { type: "boolean", description: "false when neither the call nor the written answers say anything about this topic; then say so in one line in summary and leave the lists empty." },
          audience: { type: "string", description: "Who the video speaks to, e.g. \"Sellers\" or \"Buyers, particularly empty nesters\"." },
          where: { type: ["string", "null"], description: "The transcript time range where it was discussed (\"46:22 to 51:44\"), or \"Written answers\"; null if unknown." },
          summary: { type: "string", description: "What the client said about this topic, in plain words, 2 to 4 short paragraphs: their concern, their point, what they want viewers to understand. Attribute to the client; never present the strategist's words as theirs." },
          details: { type: "array", items: { type: "string" }, description: "The specific things the client named (lists, steps, features, numbers), each as one short line in plain words." },
          examples: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "kind"],
              properties: {
                text: { type: "string", description: "The story or example as the client told it, with the real numbers and details they gave." },
                kind: { type: "string", enum: ["real", "speculation", "hypothetical"], description: "real = something that happened, as they told it; speculation = their guess about it; hypothetical = an illustration, not a real event." },
              },
            },
          },
          herWords: { type: "array", items: { type: "string" }, description: "Up to 4 short lines in the client's own words worth keeping, copied exactly from the transcript or answers." },
          fromStrategist: { type: "array", items: { type: "string" }, description: "Ideas for this topic that came from the strategist (production ideas, phrasings, examples), each saying it came from them." },
          notEstablished: { type: "array", items: { type: "string" }, description: "What the call or answers did not establish that a script might be tempted to invent (a cost, an outcome, a name)." },
          overlap: { type: ["string", "null"], description: "A recently delivered or also-chosen video this one must stay distinct from, and how; null if none." },
        },
      },
    },
    held: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why", "ideas"],
        properties: { title: { type: "string" }, why: { type: "string" }, ideas: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

export const BRIEF_INSTRUCTIONS = `You prepare the scripting brief for a real estate agent's monthly short-form videos at Realtour Pilot.

You are given the topics the agent chose for this month and either the transcript of the strategy call where they were chosen (between the agent and Jordan Spackman, Realtour Pilot's strategist) or the agent's written answers to questions about each topic. For EACH chosen topic, write a detailed summary of what the agent said about it, so a script writer who never heard the call can write the script from your summary alone.

How to write it:
- Report what the agent actually said: their concern, their point, the specific things they named, their real stories with the real numbers and details, and the short lines in their own words worth keeping. Plain words, written about the agent ("Erica's concern was...", "Her point was...").
- Keep who said what straight. Ideas, phrasings and examples that came from Jordan (or another person) go in fromStrategist, never in the agent's summary. A phrase the agent quoted from someone else is theirs to borrow only if they said so.
- Mark every story: real (it happened, as they told it), speculation (their guess about it), or hypothetical (an illustration). Never upgrade a guess into a fact.
- Say what was not established, so nothing is invented later: a missing cost, outcome, name or number.
- Note overlap: when the agent or Jordan mentioned a recently delivered video on the same subject, or two chosen topics are close, say how this one must stay distinct.
- Use the transcript's own timestamps for where each topic was discussed when the transcript has them.
- Leave out what a buyer or seller would not need: deal-specific confidential details (a live client's name, an address under contract, commission terms), small talk, scheduling.
- Topics discussed but held for a later month go in held, with why and the supporting ideas.
- A chosen topic the call never discussed and the agent has not answered questions on is marked discussed: false. Never fill it from the topic's title or description.
- The call document may open with Gemini's automatic notes. They are a machine summary: take the agent's words, stories and facts from the transcript itself, and use the notes only to find your way.
- Write no script and no hooks. No em dashes or en dashes in your own sentences.`;

const EXAMPLE_KIND: Record<BriefExample["kind"], string> = { real: "Real example", speculation: "Her guess, not a confirmed outcome", hypothetical: "Illustration, not a real event" };

/** One topic as Jordan read it in his extraction. */
export function topicBriefText(t: TopicBrief, n?: number): string {
  const lines: string[] = [];
  if (!t.discussed) return `${n ? `${n}. ` : ""}${t.title}\n\n${t.summary.trim() || "Not discussed on the call and no written answers yet."}`;
  lines.push(`${n ? `${n}. ` : ""}${t.title}`);
  lines.push(`Audience: ${t.audience}${t.where ? ` | ${/written/i.test(t.where) ? t.where : `Discussion: ${t.where}`}` : ""}`);
  lines.push(t.summary.trim());
  if (t.details.length) lines.push(t.details.map((d) => `* ${d}`).join("\n"));
  for (const e of t.examples) lines.push(`${EXAMPLE_KIND[e.kind]}: ${e.text}`);
  if (t.herWords.length) lines.push(`In her words: ${t.herWords.map((w) => `"${w.replace(/^"|"$/g, "")}"`).join(" ")}`);
  for (const s of t.fromStrategist) lines.push(`From the strategist: ${s}`);
  for (const s of t.notEstablished) lines.push(`Not established: ${s}`);
  if (t.overlap) lines.push(`Overlap to watch: ${t.overlap}`);
  return lines.join("\n\n");
}

/** The whole month, top to bottom, the way Jordan's extraction read. */
export function monthBriefText(b: MonthBrief): string {
  const out: string[] = [b.opening.trim()];
  if (b.mainRequest) out.push(`Main request: ${b.mainRequest}`);
  b.topics.forEach((t, i) => out.push(topicBriefText(t, i + 1)));
  for (const h of b.held) out.push(`Held for later: "${h.title}". ${h.why}${h.ideas.length ? ` Supporting ideas: ${h.ideas.join("; ")}.` : ""}`);
  return out.join("\n\n");
}
