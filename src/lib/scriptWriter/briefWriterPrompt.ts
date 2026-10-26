// ---------------------------------------------------------------------------
// SUMMARY -> SCRIPT, THE WAY JORDAN'S SCRIPTING GPT DOES IT (Oct 26 2026).
// Jordan: "do the call, have chatGPT analyze the transcript, and extract the
// video topics chosen, and a detailed summary of what the agent said about each
// one. And then I would copy that summary, and send it to my custom Scripting
// GPT, and it would create the script for each one."
//
// REBUILT THE SAME EVENING (v4). Jordan, on the v3 drafts: "It doesn't flow
// like the example scripts of Erica's that I sent you ... I feel like there are
// too many old rules and stuff overlapping, and it just needs to be
// restructured to fit the new GPT skill i sent you." So the writer is told
// only what his GPT is told:
//   · its instructions: his GPT's PERSONAL BRANDING SCRIPT GENERATOR, then his
//     additional rules (houseReference.JORDAN_SCRIPT_RULES, they win where the
//     two differ: 55 to 70 words);
//   · the scripts his GPT wrote for Erica Walker as how a script reads (the
//     one written for the same topic is never shown);
//   · a short note on the agent (market, audience, voice, this month's
//     priority, the month's other videos) and the topic's summary, the agent's
//     strongest lines included (his rule 2).
// Gone: the three old GPT files, the 14,000-character strategy, other clients'
// scripts, the part-by-part JSON fields. The model writes the script in his
// GPT's own output format (section 3), as one piece, and the hub reads the
// parts out of it (parseScriptFormat).
//
// HIS RULE 6, "Before submitting, independently check structure, word count,
// source accuracy, and spoken delivery": every draft and revision is read by a
// second call (checkerSystem) with the hub's own word count, and comes back
// as it was (PASS) or fixed (FIXED). Direct to camera only: a skit stays on
// its own writer (contentGeneration.routeScriptDraft).
// ---------------------------------------------------------------------------
import { JORDAN_SCRIPT_RULES, PERSONAL_BRANDING_GENERATOR } from "./houseReference";

/**
 * Length (his rule 1): about 55 to 70 spoken words (hook + three talking
 * points + close). The checker tightens anything over `tighten`; a script
 * still over `again` after it gets a second check; `hard` is the line Jordan
 * drew earlier ("less than 100 words").
 */
export const LENGTH = { min: 55, max: 70, tighten: 75, again: 80, hard: 99 } as const;

/** The writer answers with the one video in his GPT's output format. */
export const BRIEF_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["script"],
  properties: {
    script: { type: "string", description: "The one video in your exact output format (section 3), from \"Video 1:\" to \"Production:\"." },
  },
} as const;

/** The checker answers with its verdict, what failed, and the whole script (unchanged on PASS). */
export const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "issues", "script"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FIXED"] },
    issues: { type: "array", items: { type: "string" }, description: "What failed, a few words each. Empty on PASS." },
    script: { type: "string", description: "The whole script in the exact output format: unchanged on PASS, fixed on FIXED." },
  },
} as const;

export const SKIT_NOTE = `THIS VIDEO IS A SKIT. Write it as the scene the client acts out, in the same five parts: the HOOK is the opening line or moment of the bit; the three talking points are its beats (set-up, escalation, turn), each the line(s) spoken, with the speaker named when someone else speaks ("Husband (off camera): ..."); the CLOSE lands the point in the client's own voice. Keep the bit to one clear premise, near the length of the talking-to-camera scripts, counting only the lines said out loud (speaker names and stage directions do not count).`;

const OPENING = "You are Realtour Pilot's Scripting GPT, as configured by Jordan Spackman.";
const RULES = `=== YOUR INSTRUCTIONS ===\n${PERSONAL_BRANDING_GENERATOR}\n\n=== JORDAN'S ADDITIONAL RULES (where these differ from the instructions above, these win) ===\n${JORDAN_SCRIPT_RULES}`;

export function briefWriterSystem(): string {
  return [
    `${OPENING} These are your instructions.`,
    RULES,
    `=== THIS REQUEST ===\nOne video at a time: write it in your exact output format from section 3, from "Video 1:" to "Production:", with no batch header and no Strategic Batch Notes. The summary holds more than one video needs: use only what carries this video's one idea, and name a builder, community or person only when the viewer needs the name to follow it. Never write an em dash or an en dash.`,
  ].join("\n\n");
}

/** Rule 6: the independent check, with the same instructions. */
export function checkerSystem(): string {
  return [
    `${OPENING} This time you are checking a script before it is submitted, independently of whoever wrote it (Jordan's rule 6). These are the instructions it was written to.`,
    RULES,
    `=== THE CHECK ===
1. STRUCTURE: "Video 1:" with a title, CATEGORY, HOOK, exactly three talking points (1 REHOOK, 2 BUILD, 3 PAYOFF), CLOSE, Caption CTA, Production. The rehook adds something new; it never restates the hook.
2. WORD COUNT: the hub counted the spoken words (hook, three talking points, close) for you; trust its count. Approximately 55 to 70. Over 75 it must be tightened; it is never 100 or more. Remove repetition before removing personality.
3. SOURCE ACCURACY: every experience, client story, transaction detail, number, place and opinion must be in the summary. An idea the summary marks as Jordan's or the strategist's is never told as the agent's own experience, and what it lists as not established stays out. Cut or soften anything the summary does not support; never add a fact.
4. SPOKEN DELIVERY: read it out loud. Each line leads into the next, in natural sentences; a run of clipped fragments ("Grading. Retaining walls. Coverage.") reads like a list, not speech, so keep a fragment only where it lands. Bold, conversational phrasing kept, the agent's strongest real lines kept, nothing generic or corporate, no name the viewer doesn't need. The close is a memorable ending, not an obligatory sales pitch.
Be strict: hold every line against the scripts Jordan loved in what it was written from; a line that would not sit in one of them gets fixed.
If all four pass, return the script exactly as it is with verdict PASS and no issues. If anything fails, fix only what fails, return the whole script in the same format with verdict FIXED, and name each issue in a few words. Never write an em dash or an en dash.`,
  ].join("\n\n");
}

export type WriterBrief = {
  clientName: string;
  /** Market, audience, brand voice: a few lines from their strategy. */
  profile: string | null;
  voice: string | null;
  priority?: string | null;
  /** His GPT's scripts, in its own format, and whose they were. */
  good: { forClient: string; text: string }[];
  otherTopics: string[];
  skit: boolean;
  cast?: string | null;
  topicTitle: string;
  briefText: string;
};

/** What his GPT is handed: how its scripts read, who the agent is, and the summary for this one video. */
export function briefWriterUser(o: WriterBrief): string {
  const goodFor = [...new Set(o.good.map((g) => g.forClient))].join(" and ");
  return [
    o.good.length ? `SCRIPTS YOU WROTE THAT JORDAN LOVED (for ${goodFor}). This is how your scripts read: one thought from the hook to the close, each line leading into the next, short and spoken. Never reuse their content.\n\n${o.good.map((g) => g.text).join("\n\n")}` : "",
    [`THE AGENT: ${o.clientName}`, o.profile, o.voice ? `How they sound:\n${o.voice}` : "", o.priority ? `Their stated priority this month: ${o.priority}` : "", o.otherTopics.length ? `The other videos this month (keep this one distinct):\n${o.otherTopics.map((t) => `- ${t}`).join("\n")}` : ""].filter(Boolean).join("\n"),
    o.skit ? [SKIT_NOTE, o.cast ?? ""].filter(Boolean).join("\n\n") : "",
    `THE SUMMARY OF WHAT ${o.clientName.toUpperCase()} SAID ABOUT THIS VIDEO:\n${o.briefText}`,
    `Write Video 1: ${o.topicTitle}.`,
  ].filter(Boolean).join("\n\n");
}

export type FormatParts = { title?: string | null; category?: string | null; hook: string; points: string[]; close: string; captionCta?: string | null; production?: string | null };

/** A script in his GPT's output format (section 3). */
export function scriptInFormat(o: FormatParts, n = 1): string {
  const roles = ["REHOOK", "BUILD", "PAYOFF"];
  return [
    `Video ${n}: ${o.title?.trim() || "Untitled"}`,
    o.category?.trim() ? `CATEGORY: ${o.category.trim()}` : "",
    "HOOK", o.hook.trim(),
    ...o.points.slice(0, 3).flatMap((p, i) => [`TALKING POINT ${i + 1}: ${roles[i]}`, p.trim()]),
    "CLOSE", o.close.trim(),
    `Caption CTA: ${o.captionCta?.trim() || "None"}`,
    `Production: ${o.production?.trim() || "None"}`,
  ].filter((l) => l !== "").join("\n");
}

type Slot = "title" | "category" | "hook" | "p1" | "p2" | "p3" | "close" | "caption" | "production" | "end";
const MARKERS: { slot: Slot; re: RegExp }[] = [
  { slot: "title", re: /^video\s*\d*\s*:\s*(.*)$/i },
  { slot: "category", re: /^category\s*:\s*(.*)$/i },
  { slot: "hook", re: /^hook\b\s*:?\s*(.*)$/i },
  { slot: "p1", re: /^talking\s*point\s*#?\s*1\b\s*[:.\-–—]?\s*(?:\(?\s*re-?hook\s*\)?\s*:?)?\s*(.*)$/i },
  { slot: "p2", re: /^talking\s*point\s*#?\s*2\b\s*[:.\-–—]?\s*(?:\(?\s*build(?:-?up)?\s*\)?\s*:?)?\s*(.*)$/i },
  { slot: "p3", re: /^talking\s*point\s*#?\s*3\b\s*[:.\-–—]?\s*(?:\(?\s*payoff\s*\)?\s*:?)?\s*(.*)$/i },
  { slot: "close", re: /^(?:close|outro)\b\s*:?\s*(.*)$/i },
  { slot: "caption", re: /^caption\s*cta\s*:?\s*(.*)$/i },
  { slot: "production", re: /^production\s*:?\s*(.*)$/i },
  { slot: "end", re: /^strategic\s+batch\s+notes\b/i },
];
const NONE = /^(none|n\/a|na|null|-)\.?$/i;

/**
 * The parts out of a script in his GPT's format. Tolerant of markdown (#, **)
 * and of a part written on its marker's line. Null unless the hook, all three
 * talking points and the close are there.
 */
export function parseScriptFormat(text: string): { title: string | null; category: string | null; hook: string; points: string[]; close: string; captionCta: string | null; production: string | null } | null {
  const got: Partial<Record<Slot, string[]>> = {};
  let at: Slot | null = null;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    // Markdown bold anywhere and heading marks are dropped: "**HOOK:** ..." reads as "HOOK: ...".
    const line = raw.replace(/\*\*|__/g, "").replace(/^\s*#+\s*/, "").trim();
    const m = MARKERS.map((k) => ({ k, hit: line.match(k.re) })).find((x) => x.hit);
    if (m) {
      if (m.k.slot === "end") break;
      at = m.k.slot;
      got[at] = [];
      const rest = (m.hit![1] ?? "").trim();
      if (rest) got[at]!.push(rest);
      continue;
    }
    if (at && line) got[at]!.push(line);
  }
  const part = (s: Slot) => (got[s] ?? []).join("\n").trim();
  const opt = (s: Slot) => { const v = part(s); return v && !NONE.test(v) ? v : null; };
  const hook = part("hook"), p1 = part("p1"), p2 = part("p2"), p3 = part("p3"), close = part("close");
  if (!hook || !p1 || !p2 || !p3 || !close) return null;
  return { title: opt("title"), category: opt("category"), hook, points: [p1, p2, p3], close, captionCta: opt("caption"), production: opt("production") };
}

/** The checker's prompt: what the script was written from, the script, and the hub's count. */
export function checkPrompt(o: { writerPrompt: string; script: string; words: number; again: boolean }): string {
  return [
    `WHAT THE SCRIPT WAS WRITTEN FROM:\n${o.writerPrompt.replace(/\n\nWrite Video 1: [^\n]*$/, "")}`,
    `THE SCRIPT TO CHECK:\n${o.script}`,
    `THE HUB'S COUNT: ${o.words} spoken words (hook, three talking points and close).${o.words > LENGTH.tighten ? ` That is over ${LENGTH.tighten}: tighten it toward ${LENGTH.min} to ${LENGTH.max}, repetition first, personality last.` : ""}${o.again ? " It was checked once and is still long: bring it inside the range this time." : ""}`,
    "Check it.",
  ].join("\n\n");
}
